import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import {
  AUDIT_ENTRY,
  BACKUP_VERSION,
  backupManifestSchema,
  FILES_INDEX_ENTRY,
  jsonBytes,
  STORED_JSON_BYTES,
  MANIFEST_ENTRY,
} from "@/lib/backup-format";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eachSpooled, spoolWriter } from "@/server/backup/spool";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  customer,
  emailLog,
  exportJob,
  file,
  invoice,
  invoiceLine,
  invoiceTemplate,
  invoiceVersion,
  job,
  schedulerState,
  user,
} from "@/server/db/schema";
import { ACCOUNT_ROW_LIMITS } from "@/lib/account-limits";
import { TEXTS } from "@/lib/texts";
import { drainHeavy } from "@/server/jobs/worker";
import { createBackup } from "@/server/services/account-backup";
import { writeBlob } from "@/server/files/store";
import { registerJob } from "@/server/jobs/registry";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { recoverRestore, runRestore } from "@/server/services/account-restore";
import {
  asVersion1,
  asRestored,
  backupArchive,
  editArchive,
  jsonl,
  canonicalAccount,
  readJsonl,
  restoreArchive,
  seedRichAccount,
} from "../helpers/backup-compare";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedOwner } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-roundtrip-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");

beforeAll(() => {
  registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
  registerJob("restore.run", { run: runRestore, recover: recoverRestore });
});
beforeEach(() => {
  db.delete(job).run();
  db.delete(schedulerState).run();
  setClockForTests({ now: () => NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  setClockForTests(null);
  vi.restoreAllMocks();
});

function emptyAccount(): string {
  const id = `t-${randomUUID()}`;
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: NOW, updatedAt: NOW })
    .run();
  return id;
}

describe("záloha a obnova dokola", () => {
  test("[TST-019] dvě kola záloha a obnova dají kanonicky shodný účet se sedícími bloby", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const expected = asRestored(canonicalAccount(db, source));

    const first = emptyAccount();
    expect((await restoreArchive(db, first, await backupArchive(db, source))).status).toBe("done");
    expect(canonicalAccount(db, first)).toEqual(expected);
    // Taken before the second backup, whose own "backup ready" notice then travels along.
    const again = canonicalAccount(db, first);
    const second = emptyAccount();
    expect((await restoreArchive(db, second, await backupArchive(db, first))).status).toBe("done");
    expect(canonicalAccount(db, second)).toEqual(again);

    for (const owner of [first, second]) assertConsistent(db, owner);
    assertConsistent(db, source);
  });
});

describe("obnova přes mezisoubory", () => {
  test("[IMP-010] mezisoubor vrátí řádky v pořadí i přes hranici bloku 1 MiB", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "fakturan-spool-")), "rows");
    mkdirSync(dir);
    // Two-byte characters around the 1 MiB block edge must not split a character or a line.
    const rows = [
      { id: "a", note: "ř".repeat(600_000), n: 1 },
      { id: "b", note: null, flags: [true, false], nested: { deep: ["x"] } },
      ...Array.from({ length: 2_000 }, (_, index) => ({ id: `c${index}`, note: "č".repeat(300) })),
    ];
    const writer = spoolWriter(dir, "customer");
    for (const row of rows) writer.append(row);
    expect(writer.close()).toBe(rows.length);
    expect(readdirSync(dir)).toEqual(["customer.jsonl"]);
    const back: unknown[] = [];
    expect(eachSpooled(dir, "customer", (row) => back.push(row))).toBe(rows.length);
    expect(back).toEqual(rows);
    expect(eachSpooled(dir, "unit", () => back.push("nic"))).toBe(0);
    expect(existsSync(join(dir, "unit.jsonl"))).toBe(false);
  });

  test("[IMP-010] obnova vloží řádky z mezisouborů a výsledek je kanonicky shodný", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    // Enough full notes that the spool file of customers spans several 1 MiB read blocks, so some
    // lines cross a block edge, in two-byte characters.
    const note = `Poznámka ${"ř".repeat(1_980)} konec`;
    const first = db.select().from(customer).where(eq(customer.userId, source)).get()!;
    db.insert(customer)
      .values(
        Array.from({ length: 600 }, (_, index) => ({
          ...first,
          id: randomUUID(),
          name: `Zákazník ${index}`,
        })),
      )
      .run();
    db.update(customer).set({ note }).where(eq(customer.userId, source)).run();
    const expected = asRestored(canonicalAccount(db, source));
    const target = emptyAccount();
    const row = await restoreArchive(db, target, await backupArchive(db, source));
    expect(row.status).toBe("done");
    expect(canonicalAccount(db, target)).toEqual(expected);
    const notes = db.select().from(customer).where(eq(customer.userId, target)).all();
    expect(notes.length).toBeGreaterThanOrEqual(600);
    expect(notes.every((row) => row.note === note)).toBe(true);
    assertConsistent(db, target);
  });
});

describe("archiv v2 se seznamem souborů", () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  test("[EXP-006] záloha v2 má files.jsonl hned za manifestem a manifest nese jeho hash", async () => {
    const source = seedOwner(db, NOW);
    const seeded = seedRichAccount(db, source, NOW);
    const entries = unzipSync(await backupArchive(db, source));
    const names = Object.keys(entries);
    expect(names.slice(0, 2)).toEqual([MANIFEST_ENTRY, FILES_INDEX_ENTRY]);
    const firstFile = names.findIndex((name) => name.startsWith("files/"));
    expect(names.indexOf(AUDIT_ENTRY)).toBe(firstFile - 1);
    expect(names.slice(2, firstFile - 1).every((name) => name.startsWith("data/"))).toBe(true);
    expect(names.slice(firstFile).every((name) => name.startsWith("files/"))).toBe(true);

    const manifest = backupManifestSchema.parse(JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)));
    expect(manifest.v).toBe(BACKUP_VERSION);
    expect(Object.keys(manifest.entries).some((name) => name.startsWith("files/"))).toBe(false);
    for (const name of names.slice(1, firstFile)) {
      expect(manifest.entries[name], name).toEqual({
        sha256: sha(entries[name]!),
        size: entries[name]!.length,
      });
    }
    const index = readJsonl(entries[FILES_INDEX_ENTRY]!);
    expect(index).toHaveLength(manifest.counts.files);
    expect(index.map((line) => `files/${line.id as string}`)).toEqual(names.slice(firstFile));
    for (const line of index) {
      const bytes = entries[`files/${line.id as string}`]!;
      expect(line).toEqual({ id: line.id, size: bytes.length, sha256: sha(bytes) });
    }
    expect(index.map((line) => line.id)).toContain(seeded.logoId);
  });

  test("[TST-019] archiv v1 se obnoví do účtu přes BACKUP_UPGRADES[1]", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const expected = asRestored(canonicalAccount(db, source));
    const v1 = asVersion1(await backupArchive(db, source));
    expect(Object.keys(unzipSync(v1))).not.toContain(FILES_INDEX_ENTRY);
    const target = emptyAccount();
    expect((await restoreArchive(db, target, v1)).status).toBe("done");
    expect(canonicalAccount(db, target)).toEqual(expected);
    assertConsistent(db, target);
  });

  test("[IMP-010] účet s 30 000 soubory se zálohuje i obnoví", { timeout: 160_000 }, async () => {
    const source = seedOwner(db, NOW);
    const ids: string[] = [];
    for (let batch = 0; batch < 30; batch++) {
      const rows = Array.from({ length: 1_000 }, (_, index) => ({
        id: randomUUID(),
        userId: source,
        kind: "logo" as const,
        mimeType: "image/png",
        name: `logo-${batch}-${index}.png`,
        size: 16,
        createdAt: NOW,
      }));
      db.insert(file).values(rows).run();
      for (const row of rows) {
        writeBlob(source, row.id, Buffer.from(row.id.slice(0, 16)));
        ids.push(row.id);
      }
    }
    const archive = await backupArchive(db, source);
    const target = emptyAccount();
    expect((await restoreArchive(db, target, archive)).status).toBe("done");
    const old = new Set(ids);
    const restored = db
      .select({ id: file.id })
      .from(file)
      .where(eq(file.userId, target))
      .all()
      .filter(({ id }) => !old.has(id));
    // Every blob plus the audit archive the restore adds.
    expect(restored).toHaveLength(ids.length + 1);
  });
});

describe("dlouhá záloha a obnova", () => {
  test(
    "[ARC-007] záloha a obnova delší než lease 120 s si zámek obnovují",
    { timeout: 160_000 },
    async () => {
      const source = seedOwner(db, NOW);
      for (let batch = 0; batch < 2; batch++) {
        const rows = Array.from({ length: 1_000 }, (_, index) => ({
          id: randomUUID(),
          userId: source,
          kind: "logo" as const,
          mimeType: "image/png",
          name: `logo-${batch}-${index}.png`,
          size: 16,
          createdAt: NOW,
        }));
        db.insert(file).values(rows).run();
        for (const row of rows) writeBlob(source, row.id, Buffer.from(row.id.slice(0, 16)));
      }
      // Every reading of the clock is a second later, so the jobs run for simulated hours; any
      // reading that finds the lease of the running worker lapsed is recorded.
      let now = NOW.getTime();
      let lapsed = 0;
      let watching = false;
      setClockForTests({
        now: () => {
          now += 1_000;
          const at = new Date(now);
          if (watching) {
            watching = false;
            const state = db.select().from(schedulerState).get();
            if (state?.holder === "w" && state.leaseUntil && state.leaseUntil <= at) lapsed += 1;
            watching = true;
          }
          return at;
        },
      });
      watching = true;
      const archive = await backupArchive(db, source);
      const target = emptyAccount();
      const row = await restoreArchive(db, target, archive);
      watching = false;
      expect(row.status).toBe("done");
      expect(now - NOW.getTime()).toBeGreaterThan(10 * 120_000);
      expect(lapsed).toBe(0);
    },
  );
});

describe("záloha účtu s dokumenty a řádky z dřívějška", () => {
  const BE = TEXTS.backup.errors;

  test("[EXP-006] starší verze dokladu nad 256 KiB zálohu nezablokuje a obnoví se", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const version = db.select().from(invoiceVersion).where(eq(invoiceVersion.userId, source)).get();
    const invoiceId =
      version?.invoiceId ?? db.select().from(invoice).where(eq(invoice.userId, source)).get()!.id;
    const base = version?.document ?? {};
    // As the form allowed before the caps: 500 long lines frozen in an issued version.
    const lines = Array.from({ length: 500 }, (_, index) => ({
      catalogItemId: null,
      name: `Položka ${index}`,
      description: "ř".repeat(1_000),
      quantityMilli: 1000,
      unit: "ks",
      unitPriceMinor: 100,
      discountKind: "none" as const,
      discountValue: 0,
      netMinor: 100,
    }));
    const document = { ...base, lines } as never;
    db.insert(invoiceVersion)
      .values({
        id: randomUUID(),
        invoiceId,
        userId: source,
        versionNo: 99,
        document,
        createdAt: NOW,
      })
      .run();
    expect(jsonBytes(document)).toBeGreaterThan(STORED_JSON_BYTES);
    const target = emptyAccount();
    const row = await restoreArchive(db, target, await backupArchive(db, source));
    expect(row.status).toBe("done");
    const restored = db
      .select()
      .from(invoiceVersion)
      .where(eq(invoiceVersion.userId, target))
      .all()
      .find((item) => item.versionNo === 99)!;
    expect(restored.document.lines).toHaveLength(500);
  });

  test("[EXP-006] šablona nad strop a příliš mnoho šablon řeknou, co zálohu blokuje", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const template = db
      .select()
      .from(invoiceTemplate)
      .where(eq(invoiceTemplate.userId, source))
      .get()!;
    const long = {
      ...template.document,
      note: "ř".repeat(150_000),
    };
    db.update(invoiceTemplate)
      .set({ document: long })
      .where(eq(invoiceTemplate.id, template.id))
      .run();
    const { id } = createBackup({ userId: source, source: "web" });
    await drainHeavy("w");
    expect(db.select().from(exportJob).where(eq(exportJob.id, id)).get()).toMatchObject({
      status: "failed",
      reason: BE.documentTooLarge(TEXTS.backup.blocking.template(template.name)),
    });

    db.update(invoiceTemplate)
      .set({ document: template.document })
      .where(eq(invoiceTemplate.id, template.id))
      .run();
    db.insert(invoiceTemplate)
      .values(
        Array.from({ length: ACCOUNT_ROW_LIMITS.invoice_template }, () => ({
          ...template,
          id: randomUUID(),
        })),
      )
      .run();
    const again = createBackup({ userId: source, source: "web" });
    await drainHeavy("w");
    expect(db.select().from(exportJob).where(eq(exportJob.id, again.id)).get()).toMatchObject({
      status: "failed",
      reason: BE.tooManyRows(
        TEXTS.accountLimits.names.invoice_template,
        ACCOUNT_ROW_LIMITS.invoice_template,
      ),
    });
  });

  test("[EXP-006] text delší, než obnova přijme, zálohu zastaví a řekne, kde je", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const client = db.select().from(customer).where(eq(customer.userId, source)).get()!;
    const doc = db
      .select()
      .from(invoice)
      .where(eq(invoice.userId, source))
      .all()
      .find((row) => row.number)!;
    const line = db.select().from(invoiceLine).where(eq(invoiceLine.invoiceId, doc.id)).get()!;
    const backedUp = async () => {
      const { id } = createBackup({ userId: source, source: "web" });
      await drainHeavy("w");
      return db.select().from(exportJob).where(eq(exportJob.id, id)).get()!;
    };
    const cases: [() => void, () => void, string][] = [
      [
        () =>
          db
            .update(customer)
            .set({ name: "Z".repeat(201) })
            .where(eq(customer.id, client.id))
            .run(),
        () =>
          db.update(customer).set({ name: client.name }).where(eq(customer.id, client.id)).run(),
        TEXTS.backup.blocking.customer(`${"Z".repeat(60)}…`),
      ],
      [
        () =>
          db
            .update(invoiceLine)
            .set({ description: "p".repeat(2_001) })
            .where(eq(invoiceLine.id, line.id))
            .run(),
        () =>
          db
            .update(invoiceLine)
            .set({ description: line.description })
            .where(eq(invoiceLine.id, line.id))
            .run(),
        TEXTS.backup.blocking.invoice(doc.number!),
      ],
      [
        () =>
          db
            .update(invoice)
            .set({ variableSymbol: "1".repeat(11) })
            .where(eq(invoice.id, doc.id))
            .run(),
        () =>
          db
            .update(invoice)
            .set({ variableSymbol: doc.variableSymbol })
            .where(eq(invoice.id, doc.id))
            .run(),
        TEXTS.backup.blocking.invoice(doc.number!),
      ],
    ];
    for (const [spoil, mend, what] of cases) {
      spoil();
      const row = await backedUp();
      expect(row).toMatchObject({ status: "failed", reason: BE.textTooLong(what) });
      expect(row.reason).not.toMatch(/customer|invoice_line|[0-9a-f]{8}-[0-9a-f]{4}/);
      mend();
    }
    expect((await backedUp()).status).toBe("done");
  });

  test("[EXP-006] text, který skládá aplikace, záloha zkrátí místo odmítnutí a obnova ho přijme", async () => {
    const source = seedOwner(db, NOW);
    seedRichAccount(db, source, NOW);
    const doc = db
      .select()
      .from(invoice)
      .where(eq(invoice.userId, source))
      .all()
      .find((row) => row.number)!;
    db.update(invoice)
      .set({ searchText: "h".repeat(110_001) })
      .where(eq(invoice.id, doc.id))
      .run();
    db.update(emailLog)
      .set({ body: "b".repeat(50_001), reason: "r".repeat(4_001) })
      .where(eq(emailLog.userId, source))
      .run();

    const archive = await backupArchive(db, source);
    const target = emptyAccount();
    expect((await restoreArchive(db, target, archive)).status).toBe("done");

    const restored = db.select().from(invoice).where(eq(invoice.userId, target)).all();
    expect(restored.find((row) => row.number === doc.number)!.searchText).toBe("h".repeat(110_000));
    const logs = db.select().from(emailLog).where(eq(emailLog.userId, target)).all();
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      expect(log.body).toBe("b".repeat(50_000));
      expect(log.reason).toBe("r".repeat(4_000));
    }

    // Never silent: the backup and the restore say how many values they shortened.
    const sent = logs.length;
    const finish = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "account.backup_finish"))
      .all()
      .filter((row) => row.ownerId === source)
      .at(-1)!;
    expect(finish.after).toMatchObject({
      shortened: { "invoice.search_text": 1, "email_log.body": sent, "email_log.reason": sent },
    });
    const longer = editArchive(archive, (entries) => {
      const rows = readJsonl(entries["data/email_log.jsonl"]!).map((row) => ({
        ...row,
        subject: "s".repeat(1_001),
      }));
      entries["data/email_log.jsonl"] = jsonl(rows);
    });
    const again = emptyAccount();
    expect((await restoreArchive(db, again, longer)).status).toBe("done");
    const restore = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "account.restore"))
      .all()
      .filter((row) => row.ownerId === again)
      .at(-1)!;
    expect(restore.after).toMatchObject({ shortened: { "email_log.subject": sent } });
  });
});
