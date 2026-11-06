import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import { and, eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  jsonNodes,
  AUDIT_ENTRY,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupManifestSchema,
  dataEntry,
  FILES_INDEX_ENTRY,
  MANIFEST_ENTRY,
  RESTORE_LIMITS,
} from "@/lib/backup-format";
import { TEXTS } from "@/lib/texts";
import { createMemoryGuard, MEMORY_LIMITS } from "@/server/backup/memory-guard";
import { BACKUP_TABLES } from "@/server/backup/tables";
import { snapshot, SnapshotTooLarge } from "@/server/backup/snapshot";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  bankMailbox,
  bankNotification,
  emailLog,
  exportJob,
  file,
  invoice,
  invoiceTemplate,
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
import { readOpened } from "../helpers/opened";
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
  return unzipSync(readOpened(openExport(webActor(owner), id)));
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
    readOpened(opened);
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
    const listed = names.filter((name) => !name.startsWith("files/"));
    expect(listed.sort()).toEqual(Object.keys(manifest.entries).sort());
    const index = new Map(
      strFromU8(entries[FILES_INDEX_ENTRY]!)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((line) => [`files/${line.id as string}`, line]),
    );
    for (const name of names) {
      const bytes = entries[name]!;
      const digest = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
      if (name.startsWith("files/"))
        expect(index.get(name), name).toEqual({ id: name.slice(6), ...digest });
      else expect(manifest.entries[name], name).toEqual(digest);
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

  test("[SEC-005] složený audit se čte po řádcích a se stropy obnovy", () => {
    const owner = seedOwner(db, NOW);
    const archived = randomUUID();
    db.insert(file)
      .values({
        id: archived,
        userId: owner,
        kind: "audit_archive",
        mimeType: "application/x-ndjson",
        name: "a.jsonl",
        size: 1,
        createdAt: NOW,
      })
      .run();
    writeBlob(owner, archived, Buffer.from(`${"\n".repeat(50_000)}{"a":1}\n\n{"a":2}\n`));
    const own = db.select().from(auditLog).where(eq(auditLog.ownerId, owner)).all().length;
    const dir = join(DATA_DIR, "snimek", randomUUID());
    expect(snapshot(owner, dir, RESTORE_LIMITS).audit).toBe(own + 2);
    const small = { ...RESTORE_LIMITS, maxLines: 1 };
    expect(() => snapshot(owner, join(DATA_DIR, "snimek", randomUUID()), small)).toThrow(
      SnapshotTooLarge,
    );
  });

  test("[SEC-005] záloha nad hlídačem paměti skončí hláškou předem", async () => {
    const owner = seedOwner(db, NOW);
    const archived = randomUUID();
    db.insert(file)
      .values({
        id: archived,
        userId: owner,
        kind: "audit_archive",
        mimeType: "application/x-ndjson",
        name: "a.jsonl",
        size: 1,
        createdAt: NOW,
      })
      .run();
    // Enough lines for the guard to look at least once.
    writeBlob(owner, archived, Buffer.from('{"a":1}\n'.repeat(MEMORY_LIMITS.everyLines + 1)));
    const stats = v8.getHeapStatistics();
    const spy = vi.spyOn(v8, "getHeapStatistics").mockReturnValue({
      ...stats,
      used_heap_size: 751 * 1024 * 1024,
      heap_size_limit: 1000 * 1024 * 1024,
    });
    expect(await backedUp(owner)).toMatchObject({ status: "failed", reason: E.notRestorable });
    expect(spy).toHaveBeenCalled();
  });

  test("[SEC-005] evidence zálohy počítá složený audit", () => {
    const owner = seedOwner(db, NOW);
    const archived = randomUUID();
    db.insert(file)
      .values({
        id: archived,
        userId: owner,
        kind: "audit_archive",
        mimeType: "application/x-ndjson",
        name: "a.jsonl",
        size: 1,
        createdAt: NOW,
      })
      .run();
    writeBlob(owner, archived, Buffer.from('{"a":1}\n'.repeat(2_000)));
    const tight = createMemoryGuard(undefined, { heldBytes: 10_000, heapShare: 0.75 });
    expect(() =>
      snapshot(owner, join(DATA_DIR, "snimek", randomUUID()), RESTORE_LIMITS, tight),
    ).toThrow(SnapshotTooLarge);
  });

  test("[EXP-006] limity obnovy drží paměť a záloha je zrcadlí", () => {
    expect(RESTORE_LIMITS).toMatchObject({
      maxLines: 300_000,
      dataTotalBytes: 256 * 1024 * 1024,
      manifestBytes: 1024 * 1024,
      entries: 200_000,
    });
    const many = { "files/a": { size: 1 }, "files/b": { size: 1 } };
    expect(
      restorableProblem(
        many,
        { tables: {}, files: 2, audit: 0 },
        { ...RESTORE_LIMITS, entries: 2 },
      ),
    ).toBe(E.tooManyFiles("2"));
    expect(E.tooManyFiles(RESTORE_LIMITS.entries.toLocaleString("cs-CZ"))).toMatch(/200\s000/);
    const counts = { tables: { unit: 1 }, files: 0, audit: 0 };
    const entries = {
      "data/unit.jsonl": { size: 60 },
      "data/customer.jsonl": { size: 60 },
      "audit.jsonl": { size: 500 },
    };
    expect(restorableProblem(entries, counts, { ...RESTORE_LIMITS, dataTotalBytes: 100 })).toBe(
      E.notRestorable,
    );
    expect(
      restorableProblem(entries, counts, { ...RESTORE_LIMITS, dataTotalBytes: 120 }),
    ).toBeNull();
  });

  test("[EXP-006] záloha počítá uzly JSON stejně jako obnova", () => {
    expect(jsonNodes('{"a":[1,2,{"b":"x,y{"}],"c":{}}')).toMatchObject({
      containers: 4,
      nodes: 10,
      depth: 3,
    });
    const counts = { tables: { unit: 1 }, files: 0, audit: 0 };
    const entries = { "data/unit.jsonl": { size: 10 } };
    const small = { ...RESTORE_LIMITS, maxNodes: 10, maxContainers: 3, maxLineContainers: 2 };
    expect(
      restorableProblem(entries, counts, small, 0, 0, {
        nodes: 11,
        containers: 1,
        lineContainers: 1,
        lineDepth: 1,
      }),
    ).toBe(E.notRestorable);
    expect(
      restorableProblem(entries, counts, small, 0, 0, {
        nodes: 5,
        containers: 4,
        lineContainers: 1,
        lineDepth: 1,
      }),
    ).toBe(E.notRestorable);
    expect(
      restorableProblem(entries, counts, small, 0, 0, {
        nodes: 5,
        containers: 1,
        lineContainers: 3,
        lineDepth: 1,
      }),
    ).toBe(E.notRestorable);
    expect(
      restorableProblem(entries, counts, small, 0, 0, {
        nodes: 5,
        containers: 1,
        lineContainers: 1,
        lineDepth: 1,
      }),
    ).toBeNull();
    const owner = seedOwner(db, NOW);
    const stats = snapshot(owner, join(DATA_DIR, "snimek", randomUUID()), RESTORE_LIMITS).nodes;
    expect(stats.nodes).toBeGreaterThan(stats.containers);
    expect(stats.lineContainers).toBeGreaterThan(0);
    expect(stats.lineDepth).toBeGreaterThan(0);
  });

  test("[EXP-006] účet o 300 000 řádcích v poměru 1:3:1 je obnovitelný", () => {
    const MiB = 1024 * 1024;
    // Sizes measured on real rows (plan 8 re-review): 2.4 KB an invoice, 0.3 KB a line.
    const entries = {
      "data/invoice.jsonl": { size: 140 * MiB },
      "data/invoice_line.jsonl": { size: 52 * MiB },
      "data/payment.jsonl": { size: 19 * MiB },
      "audit.jsonl": { size: 0 },
    };
    const counts = {
      tables: { invoice: 60_000, invoice_line: 180_000, payment: 60_000 },
      files: 0,
      audit: 0,
    };
    expect(
      restorableProblem(entries, counts, RESTORE_LIMITS, 2_400, 0, {
        nodes: 19_300_000,
        containers: 590_000,
        lineContainers: 6,
        lineDepth: 4,
      }),
    ).toBeNull();
    expect(RESTORE_LIMITS.maxNodes).toBe(25_000_000);
  });

  test("[EXP-006] záloha s řádkem hloubky 41 skončí hláškou předem", async () => {
    const counts = { tables: { unit: 1 }, files: 0, audit: 0 };
    const entries = { "data/unit.jsonl": { size: 10 } };
    const stats = { nodes: 5, containers: 1, lineContainers: 1 };
    expect(
      restorableProblem(entries, counts, RESTORE_LIMITS, 0, 0, { ...stats, lineDepth: 41 }),
    ).toBe(E.notRestorable);
    expect(
      restorableProblem(entries, counts, RESTORE_LIMITS, 0, 0, { ...stats, lineDepth: 40 }),
    ).toBeNull();

    const owner = seedOwner(db, NOW);
    // The row object is the first level, so 40 levels of document make a line of depth 41.
    let deep: Record<string, unknown> = {};
    for (let level = 1; level < 40; level++) deep = { x: deep };
    db.insert(invoiceTemplate)
      .values({
        id: randomUUID(),
        userId: owner,
        name: "Hluboká",
        document: deep as never,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    expect(await backedUp(owner)).toMatchObject({ status: "failed", reason: E.notRestorable });
  });
});
