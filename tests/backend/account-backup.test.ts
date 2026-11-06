import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUDIT_ENTRY,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupManifestSchema,
  dataEntry,
  MANIFEST_ENTRY,
  RESTORE_LIMITS,
} from "@/lib/backup-format";
import { TEXTS } from "@/lib/texts";
import { BACKUP_TABLES } from "@/server/backup/tables";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  bankMailbox,
  bankNotification,
  emailLog,
  exportJob,
  file,
  invoice,
  job,
  mailSettings,
  payment,
  rateLimit,
  schedulerState,
  supplier,
} from "@/server/db/schema";
import { blobPath, writeBlob } from "@/server/files/store";
import { registerJob } from "@/server/jobs/registry";
import { drainHeavy } from "@/server/jobs/worker";
import { RATE_RULES } from "@/server/rate-limit";
import { RateLimitError } from "@/server/services/access";
import {
  createBackup,
  recoverBackupJob,
  restorableProblem,
  runBackup,
} from "@/server/services/account-backup";
import { ExportNotFoundError, openExport } from "@/server/services/exports";
import { archiveSentPdf } from "@/server/services/files";
import pkg from "../../package.json";
import journal from "../../drizzle/meta/_journal.json";
import { createTestDb } from "../helpers/db";
import { issuedInvoice, seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";

const DATA_DIR = mkdtempSync(join(tmpdir(), "fakturan-backup-"));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", DATA_DIR);

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
let current = NOW;
const E = TEXTS.backup.errors;
const SMTP_MARK = "ZNACKA-SMTP-7f3a1c";
const IMAP_MARK = "ZNACKA-IMAP-9c2e5d";

beforeAll(() => registerJob("backup.run", { run: runBackup, recover: recoverBackupJob }));
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

const exportRow = (id: string) => db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;
const userFiles = (owner: string) => {
  const dir = join(DATA_DIR, "files", owner);
  return existsSync(dir) ? readdirSync(dir) : [];
};

async function backedUp(owner: string) {
  const { id } = createBackup(webActor(owner));
  await drainHeavy("w");
  return exportRow(id);
}

function archive(owner: string, id: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(openExport(webActor(owner), id).path)));
}

function rows(entries: Record<string, Uint8Array>, table: string): Record<string, unknown>[] {
  const text = strFromU8(entries[dataEntry(table)]!);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// A filled account: a foreign invoice with a clause, a sent PDF, a logo, a foreign currency
// payment, a bank notice and both mail passwords.
function seedAccount(owner: string) {
  const customerId = seedCustomer(owner);
  const invoiceId = issuedInvoice(owner, customerId);
  db.update(invoice)
    .set({ foreign: true, clause: "Daň odvede zákazník" })
    .where(eq(invoice.id, invoiceId))
    .run();
  const logoId = randomUUID();
  db.insert(file)
    .values({
      id: logoId,
      userId: owner,
      kind: "logo",
      mimeType: "image/png",
      name: "logo.png",
      size: 4,
      createdAt: NOW,
    })
    .run();
  writeBlob(owner, logoId, Buffer.from("LOGO"));
  db.update(supplier).set({ logoFileId: logoId }).where(eq(supplier.userId, owner)).run();
  const logId = randomUUID();
  db.insert(emailLog)
    .values({
      id: logId,
      userId: owner,
      invoiceId,
      kind: "invoice",
      trigger: "manual",
      to: ["alfa@example.cz"],
      cc: [],
      bcc: [],
      subject: "Faktura",
      body: "Dobrý den",
      status: "sent",
      invoiceRevision: 1,
      messageId: `<${logId}@example.cz>`,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  const sentPdf = archiveSentPdf(webActor(owner), logId, Buffer.from("%PDF-1.4 odeslano"), "F.pdf");
  const noticeId = randomUUID();
  db.insert(bankNotification)
    .values({
      id: noticeId,
      userId: owner,
      dedupeKey: `msg:${noticeId}-otisk`,
      bank: "fio",
      status: "matched",
      authResult: "pass",
      receivedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  const paymentId = randomUUID();
  db.insert(payment)
    .values({
      id: paymentId,
      userId: owner,
      invoiceId,
      kind: "payment",
      paidOn: "2026-03-10",
      amountMinor: 1_000,
      currency: "EUR",
      creditedMinor: 25_000,
      rateMicros: 25_125_000,
      method: "transfer",
      source: "notice",
      notificationId: noticeId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(mailSettings)
    .values({
      userId: owner,
      smtpHost: "smtp.example.cz",
      smtpPasswordEnc: SMTP_MARK,
      updatedAt: NOW,
    })
    .run();
  db.insert(bankMailbox)
    .values({
      userId: owner,
      host: "imap.example.cz",
      port: 993,
      tls: "implicit",
      username: "avizo",
      passwordEnc: IMAP_MARK,
      updatedAt: NOW,
    })
    .run();
  return { customerId, invoiceId, logoId, sentPdfId: sentPdf.id, noticeId, paymentId, logId };
}

describe("záloha účtu", () => {
  test("[EXP-006] archiv má manifest, data, soubory, audit a sedící SHA-256", async () => {
    const owner = seedOwner(db, NOW);
    const seeded = seedAccount(owner);
    const row = await backedUp(owner);
    expect(row).toMatchObject({ kind: "backup", status: "done" });

    const opened = openExport(webActor(owner), row.id);
    expect(opened.fileName).toBe("fakturan-zaloha-2026-03-20.zip");
    expect(opened.mimeType).toBe("application/zip");
    const entries = archive(owner, row.id);
    const manifest = backupManifestSchema.parse(JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)));
    expect(manifest).toMatchObject({
      format: BACKUP_FORMAT,
      v: BACKUP_VERSION,
      app: pkg.version,
      migration: journal.entries.at(-1)!.tag,
    });

    const names = Object.keys(entries).filter((name) => name !== MANIFEST_ENTRY);
    expect(names.sort()).toEqual(Object.keys(manifest.entries).sort());
    for (const name of names) {
      const bytes = entries[name]!;
      expect(manifest.entries[name], name).toEqual({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      });
    }
    for (const entry of BACKUP_TABLES) expect(names).toContain(dataEntry(entry.name));
    expect(names).toEqual(
      expect.arrayContaining([`files/${seeded.logoId}`, `files/${seeded.sentPdfId}`, AUDIT_ENTRY]),
    );
    expect(strFromU8(entries[`files/${seeded.logoId}`]!)).toBe("LOGO");
    expect(manifest.counts.tables.invoice).toBe(1);
    expect(manifest.counts.files).toBe(2);

    const audit = strFromU8(entries[AUDIT_ENTRY]!)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.length).toBe(manifest.counts.audit);
    expect(audit.every((entry) => entry.owner_id === owner)).toBe(true);
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["invoice.issue", "account.backup"]),
    );

    const actions = db
      .select({ action: auditLog.action, entity: auditLog.entity })
      .from(auditLog)
      .where(eq(auditLog.ownerId, owner))
      .all();
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: "account.backup", entity: "account_backup" },
        { action: "account.backup_finish", entity: "account_backup" },
        { action: "account.backup_download", entity: "account_backup" },
      ]),
    );
  });

  test("[EXP-009] značky v heslech SMTP a IMAP v archivu nejsou", async () => {
    const owner = seedOwner(db, NOW);
    seedAccount(owner);
    const row = await backedUp(owner);
    expect(row.status).toBe("done");
    const entries = archive(owner, row.id);
    for (const [name, bytes] of Object.entries(entries)) {
      const text = Buffer.from(bytes).toString("latin1");
      expect(text, name).not.toContain(SMTP_MARK);
      expect(text, name).not.toContain(IMAP_MARK);
    }
    const [mail] = rows(entries, "mail_settings");
    expect(mail).toMatchObject({ smtp_host: "smtp.example.cz" });
    expect(Object.keys(mail!)).not.toContain("smtp_password_enc");
    expect(entries[dataEntry("bank_mailbox")]).toBeUndefined();
  });

  test("[EXP-006] archiv nese foreign, clause, rate_micros, dedupe_key a sent_pdf", async () => {
    const owner = seedOwner(db, NOW);
    const seeded = seedAccount(owner);
    const entries = archive(owner, (await backedUp(owner)).id);

    const [document] = rows(entries, "invoice");
    expect(document).toMatchObject({
      id: seeded.invoiceId,
      foreign: true,
      clause: "Daň odvede zákazník",
      customer_id: seeded.customerId,
    });
    expect(document).not.toHaveProperty("user_id");
    expect(typeof document!.issued_at).toBe("number");
    expect(rows(entries, "payment")).toEqual([
      expect.objectContaining({
        id: seeded.paymentId,
        rate_micros: 25_125_000,
        notification_id: seeded.noticeId,
      }),
    ]);
    expect(rows(entries, "bank_notification")).toEqual([
      expect.objectContaining({ dedupe_key: `msg:${seeded.noticeId}-otisk` }),
    ]);
    expect(rows(entries, "email_log")).toEqual([
      expect.objectContaining({ id: seeded.logId, file_id: seeded.sentPdfId }),
    ]);
    expect(
      rows(entries, "file")
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(["logo", "sent_pdf"]);
    expect(strFromU8(entries[`files/${seeded.sentPdfId}`]!)).toBe("%PDF-1.4 odeslano");
    expect(rows(entries, "supplier")).toEqual([
      expect.objectContaining({ logo_file_id: seeded.logoId }),
    ]);
  });

  test("[SEC-002] záloha neobsahuje řádek ani soubor cizího účtu", async () => {
    const owner = seedOwner(db, NOW);
    const stranger = seedOwner(db, NOW);
    seedAccount(owner);
    const foreign = seedAccount(stranger);
    await backedUp(stranger);
    const entries = archive(owner, (await backedUp(owner)).id);

    const fileNames = Object.keys(entries).filter((name) => name.startsWith("files/"));
    expect(fileNames).toHaveLength(2);
    const marks = [stranger, ...Object.values(foreign)];
    for (const [name, bytes] of Object.entries(entries)) {
      const text = strFromU8(bytes);
      for (const mark of marks) expect(text, name).not.toContain(mark);
    }
    expect(entries[dataEntry("export_job")]).toBeUndefined();
  });

  test("[SEC-001] překročení backupUser zálohu odmítne a zapíše audit", () => {
    const owner = seedOwner(db, NOW);
    const rule = RATE_RULES.backupUser;
    expect(rule).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(RATE_RULES.restoreUser).toMatchObject({ limit: 5, windowSeconds: 3600 });
    db.insert(rateLimit)
      .values({ key: `${rule.name}:${owner}`, windowStart: current, count: rule.limit })
      .run();
    expect(() => createBackup(webActor(owner))).toThrow(RateLimitError);
    expect(db.select().from(exportJob).where(eq(exportJob.userId, owner)).all()).toEqual([]);
    const exceeded = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "rate_limit.exceeded")))
      .all();
    expect(exceeded).toHaveLength(1);
  });

  test("[EXP-006] chybějící soubor účtu zálohu zastaví a nic nezůstane", async () => {
    const owner = seedOwner(db, NOW);
    const seeded = seedAccount(owner);
    rmSync(blobPath(owner, seeded.logoId));
    const row = await backedUp(owner);
    expect(row).toMatchObject({ status: "failed", reason: E.missingFile });
    expect(() => openExport(webActor(owner), row.id)).toThrow(ExportNotFoundError);
    expect(
      userFiles(owner).filter((name) => name.startsWith("tmp-") || name.includes(row.id)),
    ).toEqual([]);
  });

  test("[TST-017] přerušení smaže dočasnou složku a neukáže rozepsaný soubor", async () => {
    const owner = seedOwner(db, NOW);
    seedAccount(owner);
    const { id } = createBackup(webActor(owner));
    const queued = db.select().from(job).where(eq(job.userId, owner)).get()!;
    // The lease is gone by the first block of the archive, as when another process took over.
    current = new Date(NOW.getTime() + 60_000);
    await expect(runBackup({ ...queued, status: "running", lockedBy: null })).rejects.toThrow();
    expect(exportRow(id)).toMatchObject({ status: "failed", reason: E.unexpected });
    expect(userFiles(owner).filter((name) => name.startsWith("tmp-") || name.includes(id))).toEqual(
      [],
    );
    expect(() => openExport(webActor(owner), id)).toThrow(ExportNotFoundError);

    const second = createBackup(webActor(owner));
    const running = db
      .select()
      .from(job)
      .where(eq(job.key, `backup:${second.id}`))
      .get()!;
    db.update(job).set({ status: "running", lockedBy: "w" }).where(eq(job.id, running.id)).run();
    const dir = join(DATA_DIR, "files", owner, `tmp-${second.id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "invoice.jsonl"), "{}\n");
    writeFileSync(`${blobPath(owner, second.id)}.part`, "PK");
    recoverBackupJob({ ...running, status: "running", lockedBy: "w" });
    expect(exportRow(second.id)).toMatchObject({
      status: "failed",
      reason: TEXTS.backup.interrupted,
    });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${blobPath(owner, second.id)}.part`)).toBe(false);
    expect(db.select().from(job).where(eq(job.id, running.id)).get()!.status).toBe("dead");
  });

  test("[EXP-009] IP a prohlížeč správce z auditu účtu do zálohy nejdou", async () => {
    const owner = seedOwner(db, NOW);
    const admin = seedOwner(db, NOW);
    db.insert(auditLog)
      .values([
        {
          at: NOW,
          actorId: admin,
          ownerId: owner,
          source: "web",
          scope: "instance",
          action: "user.deactivate",
          entity: "user",
          entityId: owner,
          ip: "203.0.113.77",
          userAgent: "ZNACKA-SPRAVCE-UA",
        },
        {
          at: NOW,
          actorId: owner,
          ownerId: owner,
          source: "web",
          scope: "user",
          action: "auth.login",
          entity: "session",
          entityId: null,
          ip: "198.51.100.9",
          userAgent: "VLASTNI-UA",
        },
      ])
      .run();
    const audit = strFromU8(archive(owner, (await backedUp(owner)).id)[AUDIT_ENTRY]!);
    expect(audit).not.toContain("203.0.113.77");
    expect(audit).not.toContain("ZNACKA-SPRAVCE-UA");
    expect(audit).toContain("VLASTNI-UA");
  });

  test("[EXP-006] záloha, kterou by obnova odmítla, vůbec nevznikne", async () => {
    const entries = { "data/unit.jsonl": { sha256: "0".repeat(64), size: 10 } };
    const small = {
      ...RESTORE_LIMITS,
      dataEntryBytes: 5,
      fileEntryBytes: 3,
      archiveBytes: 100,
      entries: 2,
    };
    const counts = { tables: { unit: 1 }, files: 0, audit: 0 };
    expect(restorableProblem(entries, counts, small)).toBe(E.notRestorable);
    expect(
      restorableProblem({ "files/x": { sha256: "0".repeat(64), size: 4 } }, counts, small),
    ).toBe(E.notRestorable);
    expect(
      restorableProblem(
        entries,
        { ...counts, tables: { unit: 11 } },
        { ...RESTORE_LIMITS, maxLinesPerTable: 10 },
      ),
    ).toBe(E.notRestorable);
    expect(restorableProblem(entries, counts, RESTORE_LIMITS)).toBeNull();

    const owner = seedOwner(db, NOW);
    const big = randomUUID();
    db.insert(file)
      .values({
        id: big,
        userId: owner,
        kind: "logo",
        mimeType: "image/png",
        name: "velke.png",
        size: 1,
        createdAt: NOW,
      })
      .run();
    writeBlob(owner, big, Buffer.alloc(RESTORE_LIMITS.fileEntryBytes + 1));
    expect(await backedUp(owner)).toMatchObject({ status: "failed", reason: E.notRestorable });
  });
});
