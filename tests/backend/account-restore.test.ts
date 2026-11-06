import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AUDIT_ENTRY } from "@/lib/backup-format";
import { TEXTS } from "@/lib/texts";
import { BACKUP_TABLES } from "@/server/backup/tables";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  automationSettings,
  bankMailbox,
  emailLog,
  exportJob,
  file,
  importBatch,
  invoice,
  job,
  mailSettings,
  notification,
  payment,
  preferences,
  recurringInvoice,
  schedulerState,
  user,
} from "@/server/db/schema";
import { readBlob, writeBlob } from "@/server/files/store";
import { registerJob } from "@/server/jobs/registry";
import { drainHeavy } from "@/server/jobs/worker";
import { ServiceError } from "@/server/services/access";
import {
  createBackup,
  lastBackupOf,
  recoverBackupJob,
  runBackup,
} from "@/server/services/account-backup";
import {
  beginRestoreUpload,
  purgeStaleRestores,
  recoverRestore,
  runRestore,
  startRestore,
} from "@/server/services/account-restore";
import { paymentProblems } from "@/server/services/data-checks";
import { ingestNotice } from "@/server/services/bank-notices";
import { deleteUser } from "@/server/services/users";
import { latestRestore } from "@/server/services/exports";
import {
  asRestored,
  backupArchive,
  canonicalAccount,
  readJsonl,
  restoreArchive,
  seedRichAccount,
} from "../helpers/backup-compare";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedBankAccount, seedMailbox, TARGET } from "../helpers/fixtures-bank";
import { issuedInvoice, seedOwner, webActor } from "../helpers/fixtures-mail";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  getCurrentSession: async () => (session.userId ? { user: { id: session.userId } } : null),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));

const DATA_DIR = mkdtempSync(join(tmpdir(), "fakturan-restore-"));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", DATA_DIR);

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
let current = NOW;
const E = TEXTS.restore.errors;

beforeAll(() => {
  registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
  registerJob("restore.run", { run: runRestore, recover: recoverRestore });
});
beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  current = NOW;
  setClockForTests({ now: () => current });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

// A brand-new account: only the user row, as right after registration.
function emptyAccount(): string {
  const id = `t-${randomUUID()}`;
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: NOW, updatedAt: NOW })
    .run();
  return id;
}

function admin(): string {
  const id = seedOwner(db, NOW);
  db.update(user).set({ role: "admin" }).where(eq(user.id, id)).run();
  return id;
}

const rowsOf = (owner: string) =>
  BACKUP_TABLES.reduce(
    (sum, entry) =>
      sum +
      (db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM ${sql.identifier(entry.name)} WHERE user_id = ${owner}`,
      )?.n ?? 0),
    0,
  );

const userFiles = (owner: string) => {
  const dir = join(DATA_DIR, "files", owner);
  return existsSync(dir) ? readdirSync(dir) : [];
};

function archiveIds(bytes: Uint8Array): string[] {
  const entries = unzipSync(bytes);
  return BACKUP_TABLES.filter((entry) => entry.columns.id === "id").flatMap((entry) =>
    readJsonl(entries[`data/${entry.name}.jsonl`]!).map((row) => row.id as string),
  );
}

describe("obnova účtu", () => {
  test("[IMP-010] obnova do prázdného účtu jiné instance vrátí shodná data s novými ID", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const before = canonicalAccount(db, source);
    const bytes = await backupArchive(db, source);
    const sourceIds = archiveIds(bytes);
    // Gone like an account of another instance: no old id can resolve to an existing row.
    deleteUser(webActor(admin()), source, `${source}@example.cz`);

    const target = emptyAccount();
    const row = await restoreArchive(db, target, bytes);
    expect(row).toMatchObject({ kind: "restore", status: "done" });
    expect(latestRestore(target)).toMatchObject({ status: "done", downloadable: false });
    expect(canonicalAccount(db, target)).toEqual(asRestored(before));
    assertConsistent(db, target);
    const ids = db.select({ id: invoice.id }).from(invoice).where(eq(invoice.userId, target)).all();
    expect(ids).toHaveLength(3);
    for (const { id } of ids) expect(sourceIds).not.toContain(id);
  });

  test("[IMP-010] účet s jedinou fakturou je odmítnutý a nic se nezmění", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const bytes = await backupArchive(db, source);
    const target = seedOwner(db, NOW);
    issuedInvoice(target);
    const before = rowsOf(target);
    const uploadId = randomUUID();
    writeBlob(target, uploadId, Buffer.from(bytes));
    expect(() => startRestore(webActor(target), uploadId)).toThrow(E.notEmpty);
    expect(() => startRestore(webActor(target), uploadId)).toThrow(ServiceError);
    expect(rowsOf(target)).toBe(before);
    expect(db.select().from(exportJob).where(eq(exportJob.userId, target)).all()).toEqual([]);
  });

  test("[IMP-010] souběžný zápis mezi kontrolou a commitem obnovu shodí", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const bytes = await backupArchive(db, source);
    const target = emptyAccount();
    const uploadId = randomUUID();
    writeBlob(target, uploadId, Buffer.from(bytes));
    const { id } = startRestore(webActor(target), uploadId);
    seedBankAccount(db, target, NOW);
    await drainHeavy("w");
    expect(db.select().from(exportJob).where(eq(exportJob.id, id)).get()).toMatchObject({
      status: "failed",
      reason: E.notEmpty,
    });
    expect(rowsOf(target)).toBe(1);
    expect(userFiles(target)).toEqual([]);
  });

  test("[IMP-010] žádné staré ID nezůstane v JSON ani v klíči upozornění", async () => {
    const source = seedOwner(db, NOW);
    const seeded = seedRichAccount(db, source, NOW);
    db.insert(notification)
      .values({
        id: randomUUID(),
        userId: source,
        kind: "recurring_missed",
        dedupeKey: `recurring:missed:${seeded.planId}:2026-03`,
        params: { planId: seeded.planId, invoiceId: seeded.paid },
        entityType: "recurring",
        entityId: seeded.planId,
        createdAt: NOW,
      })
      .run();
    const bytes = await backupArchive(db, source);
    const old = archiveIds(bytes);
    const target = emptyAccount();
    expect((await restoreArchive(db, target, bytes)).status).toBe("done");

    for (const entry of BACKUP_TABLES) {
      const rows = db.all<Record<string, unknown>>(
        sql`SELECT * FROM ${sql.identifier(entry.name)} WHERE user_id = ${target}`,
      );
      const text = JSON.stringify(rows);
      for (const id of old) expect(text, entry.name).not.toContain(id);
    }
    const notice = db
      .select()
      .from(notification)
      .where(and(eq(notification.userId, target), eq(notification.kind, "recurring_missed")))
      .get()!;
    const plan = db
      .select()
      .from(recurringInvoice)
      .where(eq(recurringInvoice.userId, target))
      .get()!;
    expect(notice.dedupeKey).toBe(`recurring:missed:${plan.id}:2026-03`);
    expect(notice).toMatchObject({ entityId: plan.id, params: { planId: plan.id } });
  });

  test("[IMP-010] audit ze zálohy je soubor a v logu je jen account.restore", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const bytes = await backupArchive(db, source);
    const target = emptyAccount();
    await restoreArchive(db, target, bytes);

    const actions = db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.ownerId, target))
      .all()
      .map((row) => row.action);
    expect(actions).toContain("account.restore");
    expect(actions).not.toContain("invoice.issue");
    expect(actions.every((action) => action.startsWith("account.restore"))).toBe(true);
    const restoreRow = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, target), eq(auditLog.action, "account.restore")))
      .get()!;
    expect(restoreRow.after).toMatchObject({ tables: expect.any(Number), files: 2 });
    expect((restoreRow.after as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    const archived = db
      .select()
      .from(file)
      .where(and(eq(file.userId, target), eq(file.kind, "audit_archive")))
      .get()!;
    expect(readBlob(target, archived.id).toString("utf8")).toBe(
      strFromU8(unzipSync(bytes)[AUDIT_ENTRY]!),
    );
  });

  test("[IMP-010] všechny spínače vypnuté, advance_final_mode draft, send_confirmed_at NULL", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    db.update(automationSettings)
      .set({ remindersOpenSince: "2026-03-01" })
      .where(eq(automationSettings.userId, source))
      .run();
    const target = emptyAccount();
    await restoreArchive(db, target, await backupArchive(db, source));

    expect(
      db.select().from(automationSettings).where(eq(automationSettings.userId, target)).get(),
    ).toMatchObject({
      recurringSend: false,
      reminders: false,
      paymentReceipt: false,
      advanceInvoice: false,
      dailyDigest: false,
      remindersOpenSince: null,
    });
    expect(db.select().from(preferences).where(eq(preferences.userId, target)).get()).toMatchObject(
      { advanceFinalMode: "draft" },
    );
    expect(
      db.select().from(recurringInvoice).where(eq(recurringInvoice.userId, target)).get(),
    ).toMatchObject({ mode: "send", sendConfirmedAt: null });
  });

  test("[IMP-010] rozpracovaná dávka importu je po obnově selhaná, hotová zůstane", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    for (const status of ["ready", "done"] as const) {
      db.insert(importBatch)
        .values({
          id: randomUUID(),
          userId: source,
          kind: "isdoc",
          status,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }
    const target = emptyAccount();
    await restoreArchive(db, target, await backupArchive(db, source));
    const statuses = db
      .select({ status: importBatch.status })
      .from(importBatch)
      .where(eq(importBatch.userId, target))
      .all()
      .map((row) => row.status)
      .sort();
    expect(statuses).toEqual(["done", "failed"]);
  });

  test("[IMP-010] queued a sending skončí cancelled a index neblokuje", async () => {
    const source = seedOwner(db, NOW);
    const seeded = seedRichAccount(db, source, NOW);
    const queued = (
      id: string,
      invoiceId: string,
      status: "queued" | "sending",
      kind = "invoice",
    ) =>
      db
        .insert(emailLog)
        .values({
          id,
          userId: source,
          invoiceId,
          kind: kind as "invoice",
          trigger: "manual",
          to: ["alfa@example.cz"],
          cc: [],
          bcc: [],
          subject: "Faktura",
          body: "Text",
          status,
          invoiceRevision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    queued(randomUUID(), seeded.paid, "queued");
    queued(randomUUID(), seeded.credited, "sending");
    const target = emptyAccount();
    await restoreArchive(db, target, await backupArchive(db, source));

    const logs = db.select().from(emailLog).where(eq(emailLog.userId, target)).all();
    expect(logs.filter((log) => log.status === "queued" || log.status === "sending")).toEqual([]);
    expect(logs.filter((log) => log.status === "cancelled")).toHaveLength(2);
    const cancelled = logs.find((log) => log.status === "cancelled")!;
    db.insert(emailLog)
      .values({ ...cancelled, id: randomUUID(), status: "queued" })
      .run();
  });

  test("[IMP-010] SMTP a IMAP chybí a upozornění vyzve k zadání", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const target = emptyAccount();
    await restoreArchive(db, target, await backupArchive(db, source));

    expect(
      db.select().from(mailSettings).where(eq(mailSettings.userId, target)).get(),
    ).toMatchObject({ smtpHost: "smtp.example.cz", smtpPasswordEnc: null, verifiedAt: null });
    expect(db.select().from(bankMailbox).where(eq(bankMailbox.userId, target)).all()).toEqual([]);
    const notice = db
      .select()
      .from(notification)
      .where(and(eq(notification.userId, target), eq(notification.kind, "backup_restored")))
      .get();
    expect(notice).toBeDefined();
    expect(TEXTS.notifications.kinds.backup_restored()).toMatch(/SMTP/);
  });

  test("[BNK-006] znovu přečtené avízo po obnově nezaloží platbu", async () => {
    const source = seedOwner(db, NOW);
    const seeded = seedRichAccount(db, source, NOW);
    const accountId = seedBankAccount(db, source, NOW);
    db.update(invoice)
      .set({ variableSymbol: "20260777", bankAccountId: accountId })
      .where(eq(invoice.id, seeded.credited))
      .run();
    const input = () => ({
      bank: "fio" as const,
      notice: {
        variant: "en" as const,
        targetAccount: `${TARGET.number}/${TARGET.bankCode}`,
        amountMinor: 1_000,
        currency: "CZK" as const,
        occurredAt: { date: "2026-03-01", time: "09:00" },
        variableSymbol: "20260777",
        constantSymbol: null,
        counterpartyAccount: null,
        counterpartyName: null,
        message: null,
        instructionId: "obnova-1",
      },
      text: "avizo",
      authResult: "pass" as const,
      requireConfirmation: false,
      receivedAt: NOW,
    });
    ingestNotice(source, input());
    const target = emptyAccount();
    await restoreArchive(db, target, await backupArchive(db, source));
    const payments = () => db.select().from(payment).where(eq(payment.userId, target)).all().length;
    const before = payments();

    const again = ingestNotice(target, input());
    expect(again.status).toBe("duplicate");
    expect(payments()).toBe(before);
  });

  test("[ADM-009] smazání nabídne zálohu a poslední běh", async () => {
    const owner = seedOwner(db, NOW);
    expect(lastBackupOf(owner)).toEqual({ lastBackupAt: null, running: false });
    const { id } = createBackup(webActor(owner));
    expect(lastBackupOf(owner)).toMatchObject({ running: true });
    await drainHeavy("w");
    const done = db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;
    expect(lastBackupOf(owner)).toEqual({ lastBackupAt: done.finishedAt, running: false });
    expect(TEXTS.backup.deleteOffer.warning).toMatch(/stáhn/);

    createBackup(webActor(owner));
    const pending = db.select().from(job).where(eq(job.userId, owner)).get()!;
    deleteUser(webActor(admin()), owner, `${owner}@example.cz`);
    expect(db.select().from(job).where(eq(job.id, pending.id)).all()).toEqual([]);
    await expect(
      runBackup({ ...pending, status: "running", lockedBy: "w" }),
    ).resolves.toBeUndefined();
    expect(userFiles(owner)).toEqual([]);
  });

  test("[SEC-002] nahrání zálohy jde jen do účtu relace a odmítnuté nic nezanechá", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const bytes = await backupArchive(db, source);
    const ORIGIN = "http://localhost:3000";
    const post = async (headers: Record<string, string> = {}) => {
      const { POST } = await import("@/app/(app)/nastaveni/zaloha/nahrani/route");
      return POST(
        new Request(`${ORIGIN}/nastaveni/zaloha/nahrani`, {
          method: "POST",
          body: Buffer.from(bytes),
          headers: { origin: ORIGIN, ...headers },
        }),
      );
    };

    session.userId = null;
    expect((await post()).status).toBe(401);
    const busy = seedOwner(db, NOW);
    session.userId = busy;
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "content-length": String(2 * 1024 ** 3) })).status).toBe(413);
    const refused = await post();
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: E.notEmpty });
    expect(userFiles(busy)).toEqual([]);

    const target = emptyAccount();
    session.userId = target;
    const accepted = await post();
    expect(accepted.status).toBe(200);
    await drainHeavy("w");
    const { id } = (await accepted.json()) as { id: string };
    expect(db.select().from(exportJob).where(eq(exportJob.id, id)).get()).toMatchObject({
      userId: target,
      status: "done",
    });
    expect(db.select().from(invoice).where(eq(invoice.userId, target)).all()).toHaveLength(3);
    expect(userFiles(target)).not.toContain(id);

    const rule = "restoreUser";
    db.run(sql`UPDATE rate_limit SET count = 5 WHERE key = ${`${rule}:${target}`}`);
    expect((await post()).status).toBe(429);
  });

  test("[IMP-010] audit z obnovy jde do audit.jsonl další zálohy, ne jako soubor", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const firstArchive = await backupArchive(db, source);
    const firstAudit = readJsonl(unzipSync(firstArchive)[AUDIT_ENTRY]!);
    const middle = emptyAccount();
    await restoreArchive(db, middle, firstArchive);
    const second = unzipSync(await backupArchive(db, middle));
    const kinds = readJsonl(second["data/file.jsonl"]!).map((row) => row.kind);
    expect(kinds).not.toContain("audit_archive");
    const audit = readJsonl(second[AUDIT_ENTRY]!);
    expect(audit.slice(0, firstAudit.length)).toEqual(firstAudit);
    expect(audit.map((row) => row.action)).toContain("account.restore");
    const last = emptyAccount();
    expect((await restoreArchive(db, last, await backupArchive(db, middle))).status).toBe("done");
  });

  test("[SEC-001] neprázdný účet odmítne nahrání dřív, než se čte tělo", async () => {
    const busy = seedOwner(db, NOW);
    session.userId = busy;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { POST } = await import("@/app/(app)/nastaveni/zaloha/nahrani/route");
    const response = await POST(
      new Request("http://localhost:3000/nastaveni/zaloha/nahrani", {
        method: "POST",
        body,
        headers: { origin: "http://localhost:3000" },
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(422);
    expect(pulled).toBe(false);
    expect(userFiles(busy)).toEqual([]);
  });

  test("[IMP-010] nahrání, které obnovu nespustilo, po hodině zmizí", async () => {
    const target = emptyAccount();
    const { id } = beginRestoreUpload(webActor(target));
    writeBlob(target, id, Buffer.from("PK rozepsané"));
    current = new Date(NOW.getTime() + 2 * 3_600_000);
    purgeStaleRestores(current);
    expect(userFiles(target)).toEqual([]);
    expect(db.select().from(exportJob).where(eq(exportJob.id, id)).get()).toMatchObject({
      status: "failed",
    });
  });

  test("[IMP-010] soubor auditu ze zálohy má jméno z textů", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const target = emptyAccount();
    await restoreArchive(db, target, await backupArchive(db, source));
    const archived = db
      .select()
      .from(file)
      .where(and(eq(file.userId, target), eq(file.kind, "audit_archive")))
      .get()!;
    expect(archived.name).toBe(TEXTS.restore.auditFileName);
  });

  test("[IMP-010] nastavená schránka avíz dělá účet neprázdným", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const bytes = await backupArchive(db, source);
    const target = emptyAccount();
    seedMailbox(db, target, 993, NOW);
    const uploadId = randomUUID();
    writeBlob(target, uploadId, Buffer.from(bytes));
    expect(() => startRestore(webActor(target), uploadId)).toThrow(E.notEmpty);
  });

  test("[TST-009] kontrola dat instance bez účtu nic nehledá a nespadne", () => {
    expect(paymentProblems(db, "")).toEqual([]);
    expect(() => assertConsistent(db, "")).not.toThrow();
  });

  test("[TST-009] kontrola plateb počítá jen doklady téhož účtu", () => {
    const owner = seedOwner(db, NOW);
    const stranger = seedOwner(db, NOW);
    const theirs = issuedInvoice(stranger);
    db.insert(payment)
      .values({
        id: randomUUID(),
        userId: owner,
        invoiceId: theirs,
        kind: "payment",
        paidOn: "2026-03-10",
        amountMinor: 100,
        currency: "CZK",
        creditedMinor: 50,
        method: "transfer",
        source: "manual",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const problems = paymentProblems(db, owner);
    expect(problems.some((problem) => problem.includes("cizím dokladem"))).toBe(true);
    expect(problems.some((problem) => problem.includes("jinou připsanou částkou"))).toBe(false);
    db.delete(payment).where(eq(payment.userId, owner)).run();
  });
});
