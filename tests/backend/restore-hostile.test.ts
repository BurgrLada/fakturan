import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, zipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MANIFEST_ENTRY, RESTORE_LIMITS } from "@/lib/backup-format";
import { prescanManifest, scanArchive } from "@/server/backup/restore-read";
import { TEXTS } from "@/lib/texts";
import { BACKUP_TABLES } from "@/server/backup/tables";
import { setClockForTests } from "@/server/clock";
import { exportJob, invoice, job, schedulerState, user } from "@/server/db/schema";
import { blobPath, writeBlob } from "@/server/files/store";
import { registerJob } from "@/server/jobs/registry";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { recoverRestore, runRestore, startRestore } from "@/server/services/account-restore";
import {
  backupArchive,
  editArchive,
  jsonl,
  readJsonl,
  restoreArchive,
  seedRichAccount,
} from "../helpers/backup-compare";
import { createTestDb } from "../helpers/db";
import { seedOwner, webActor } from "../helpers/fixtures-mail";

const DATA_DIR = mkdtempSync(join(tmpdir(), "fakturan-restore-hostile-"));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", DATA_DIR);

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const E = TEXTS.restore.errors;
let source = "";
let archive: Uint8Array = new Uint8Array();

beforeAll(async () => {
  registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
  registerJob("restore.run", { run: runRestore, recover: recoverRestore });
  setClockForTests({ now: () => NOW });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  source = seedOwner(db, NOW);
  seedRichAccount(db, source, NOW);
  archive = await backupArchive(db, source);
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

// A refused archive changes nothing: no row, no blob, no leftover folder or upload.
async function refused(bytes: Uint8Array, reason: string | RegExp = /./) {
  const target = emptyAccount();
  const row = await restoreArchive(db, target, bytes);
  expect(row.status).toBe("failed");
  expect(row.reason).toMatch(reason);
  expect(rowsOf(target)).toBe(0);
  expect(userFiles(target)).toEqual([]);
  return target;
}

const editRows = (
  table: string,
  change: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
) =>
  editArchive(archive, (entries) => {
    const name = `data/${table}.jsonl`;
    entries[name] = jsonl(change(readJsonl(entries[name]!)));
  });

describe("obnova z nepřátelského archivu", () => {
  test("[SEC-002] user_id cizího účtu v archivu se ignoruje a cizí řádky jsou netknuté", async () => {
    const stranger = seedOwner(db, NOW);
    const theirs = seedRichAccount(db, stranger, NOW);
    const strangerBefore = db.select().from(invoice).where(eq(invoice.userId, stranger)).all();
    const original = readJsonl(unzipSync(archive)["data/invoice.jsonl"]!)[0]!.id as string;
    // Every reference to the first invoice now names the stranger's invoice, owner included.
    const hostile = editArchive(archive, (entries) => {
      for (const name of Object.keys(entries).filter((key) => key.startsWith("data/"))) {
        const rows = readJsonl(entries[name]!).map((row) => ({ ...row, user_id: stranger }));
        entries[name] = strToU8(strFromU8(jsonl(rows)).replaceAll(original, theirs.paid));
      }
    });
    const target = emptyAccount();
    expect((await restoreArchive(db, target, hostile)).status).toBe("done");
    expect(db.select().from(invoice).where(eq(invoice.userId, stranger)).all()).toEqual(
      strangerBefore,
    );
    const mine = db.select().from(invoice).where(eq(invoice.userId, target)).all();
    expect(mine).toHaveLength(3);
    expect(mine.map((row) => row.id)).not.toContain(theirs.paid);
  });

  test("[SEC-002] ref mimo archiv je odmítnutý", async () => {
    await refused(
      editRows("invoice_line", (rows) => [
        { ...rows[0]!, invoice_id: randomUUID() },
        ...rows.slice(1),
      ]),
      E.reference("invoice_line"),
    );
  });

  test("[SEC-005] jméno files/../../x, cizí sloupec a neznámý klíč jsou chyba", async () => {
    await refused(
      editArchive(archive, (entries) => {
        entries["files/../../x"] = strToU8("x");
      }),
      E.manifest,
    );
    await refused(
      editRows("customer", (rows) => rows.map((row) => ({ ...row, total_minor: 5 }))),
      E.row("customer"),
    );
    await refused(
      editRows("invoice", (rows) => rows.map((row) => ({ ...row, smtp_password_enc: "x" }))),
      E.row("invoice"),
    );
    await refused(
      editArchive(archive, (entries) => {
        entries["data/session.jsonl"] = jsonl([{ id: randomUUID(), token: "x" }]);
      }),
      E.entry,
    );
    await refused(
      editRows("invoice", (rows) => rows.map((row) => ({ ...row, import_payment_code: "99" }))),
      E.row("invoice"),
    );
  });

  test("[SEC-005] změněný blob nesedí na SHA-256 a nic se nezapíše", async () => {
    const tampered = editArchive(
      archive,
      (entries) => {
        const name = Object.keys(entries).find((key) => key.startsWith("files/"))!;
        entries[name] = strToU8("jiný obsah");
      },
      () => {},
      { rehash: false },
    );
    await refused(tampered, E.hash);
  });

  test("[SEC-005] bomba, příliš velká položka, duplicita a manifest jinde než první", async () => {
    await refused(
      editArchive(archive, (entries) => {
        entries["data/unit.jsonl"] = new Uint8Array(64 * 1024 * 1024);
      }),
      E.archive,
    );
    await refused(
      editArchive(archive, (entries) => {
        const name = Object.keys(entries).find((key) => key.startsWith("files/"))!;
        entries[name] = new Uint8Array(randomBytes(26 * 1024 * 1024));
      }),
      E.archive,
    );

    const entries = unzipSync(archive);
    const duplicated: Uint8Array[] = [];
    const zip = new Zip((_, chunk) => duplicated.push(chunk));
    const add = (name: string, data: Uint8Array) => {
      const entry = new ZipDeflate(name);
      zip.add(entry);
      entry.push(data, true);
    };
    for (const [name, data] of Object.entries(entries)) add(name, data);
    add("data/unit.jsonl", entries["data/unit.jsonl"]!);
    zip.end();
    const joined = new Uint8Array(duplicated.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of duplicated) {
      joined.set(part, offset);
      offset += part.length;
    }
    await refused(joined, E.duplicate);

    const { [MANIFEST_ENTRY]: manifest, ...rest } = entries;
    await refused(zipSync({ ...rest, [MANIFEST_ENTRY]: manifest! }), E.manifest);
  });

  test("[TST-017] pád uvnitř transakce nechá účet prázdný a nové bloby zmizí", async () => {
    // Sums that no document could have: the data checks at the end of the transaction refuse them.
    await refused(
      editRows("invoice", (rows) =>
        rows.map((row, index) => (index === 0 ? { ...row, total_minor: 1 } : row)),
      ),
      E.inconsistent,
    );

    const target = emptyAccount();
    const uploadId = randomUUID();
    writeBlob(target, uploadId, Buffer.from(archive));
    const { id } = startRestore(webActor(target), uploadId);
    const running = db
      .select()
      .from(job)
      .where(eq(job.key, `restore:${id}`))
      .get()!;
    db.update(job).set({ status: "running", lockedBy: "w" }).where(eq(job.id, running.id)).run();
    // As if the process died after writing two blobs and before the commit.
    const dir = join(DATA_DIR, "files", target, `restore-${id}`);
    mkdirSync(dir, { recursive: true });
    const written = [randomUUID(), randomUUID()];
    writeFileSync(join(dir, "blobs.txt"), written.map((blob) => `${blob}\n`).join(""));
    for (const blob of written) writeBlob(target, blob, Buffer.from("x"));
    recoverRestore({ ...running, status: "running", lockedBy: "w" });
    expect(db.select().from(exportJob).where(eq(exportJob.id, id)).get()).toMatchObject({
      status: "failed",
      reason: TEXTS.restore.interrupted,
    });
    expect(userFiles(target)).toEqual([]);
    expect(existsSync(blobPath(target, uploadId))).toBe(false);
    expect(db.select().from(job).where(eq(job.id, running.id)).get()!.status).toBe("dead");
  });

  test("[EXP-006] verze v2 archivu je odmítnutá", async () => {
    await refused(
      editArchive(
        archive,
        () => {},
        (manifest) => (manifest.v = 2),
      ),
      E.version,
    );
    await refused(
      editArchive(
        archive,
        () => {},
        (manifest) => (manifest.columns = "0".repeat(64)),
      ),
      E.version,
    );
  });
});

describe("obnova z nepřátelského archivu, opravy bloku D", () => {
  const onDisk = (bytes: Uint8Array) => {
    const path = join(mkdtempSync(join(tmpdir(), "fakturan-scan-")), "zaloha.zip");
    writeFileSync(path, bytes);
    return path;
  };
  const small = { ...RESTORE_LIMITS, maxLinesPerTable: 10, maxLines: 40, maxLineBytes: 4096 };
  const reasonOf = (promise: Promise<unknown>) =>
    promise.then(
      () => "prošlo",
      (error: Error) => error.message,
    );

  test("[SEC-005] řádky nad strop tabulky, archivu i délky se odmítnou hned", async () => {
    const customers = readJsonl(unzipSync(archive)["data/customer.jsonl"]!);
    const many = editArchive(
      archive,
      (entries) => {
        entries["data/customer.jsonl"] = jsonl([
          ...customers,
          ...Array.from({ length: 10 }, (_, index) => ({
            ...customers[0]!,
            id: randomUUID(),
            name: `Zákazník ${index}`,
          })),
        ]);
      },
      (manifest) => (manifest.counts.tables.customer = customers.length + 10),
    );
    let seen = 0;
    expect(await reasonOf(scanArchive(onDisk(many), { rows: () => void (seen += 1) }, small))).toBe(
      E.tooManyLines,
    );
    expect(await reasonOf(scanArchive(onDisk(archive), {}, { ...small, maxLines: 5 }))).toBe(
      E.tooManyLines,
    );
    const long = editRows("customer", (rows) =>
      rows.map((row) => ({ ...row, note: "x".repeat(5000) })),
    );
    expect(await reasonOf(scanArchive(onDisk(long), {}, small))).toBe(E.row("customer"));
    // More lines than the manifest admits stop the read at the first surplus line.
    const surplus = editArchive(
      archive,
      (entries) => {
        entries["data/customer.jsonl"] = jsonl([
          ...customers,
          ...customers.map((row) => ({ ...row, id: randomUUID() })),
        ]);
      },
      () => {},
    );
    expect(await reasonOf(scanArchive(onDisk(surplus), {}))).toBe(E.counts);
  });

  test("[SEC-005] statisíce prázdných řádků v malém archivu skončí chybou a proces žije", async () => {
    // Below the ratio check's grace, so it is the line reader that has to stop it.
    const lines = strToU8("[]\n".repeat(200_000));
    await refused(
      editArchive(archive, (entries) => {
        entries["data/unit.jsonl"] = lines;
        entries["audit.jsonl"] = lines;
      }),
      E.counts,
    );
    await refused(
      editArchive(archive, (entries) => {
        entries["audit.jsonl"] = strToU8('{"action":"x"}\n[]\n');
      }),
      E.audit,
    );
  });

  test("[SEC-005] JSON sloupce, které čte PDF a odeslání, musí mít svůj tvar", async () => {
    await refused(
      editRows("invoice", (rows) => rows.map((row) => ({ ...row, appearance: {} }))),
      E.row("invoice"),
    );
    await refused(
      editRows("invoice", (rows) => rows.map((row) => ({ ...row, issue_date: "abc" }))),
      E.row("invoice"),
    );
    await refused(
      editRows("invoice", (rows) =>
        rows.map((row) =>
          row.customer_snapshot ? { ...row, customer_snapshot: { name: 1 } } : row,
        ),
      ),
      E.row("invoice"),
    );
    await refused(
      editRows("email_log", (rows) => rows.map((row) => ({ ...row, to: "alfa@example.cz" }))),
      E.row("email_log"),
    );
  });

  test("[IMP-010] porušený cizí klíč v cizím účtu obnovu neblokuje", async () => {
    const stranger = seedOwner(db, NOW);
    db.run(sql`PRAGMA foreign_keys = OFF`);
    db.run(sql`INSERT INTO unit (id, user_id, name, position, created_at)
      VALUES (${randomUUID()}, ${`chybi-${randomUUID()}`}, 'ks', 0, 0)`);
    db.run(sql`PRAGMA foreign_keys = ON`);
    expect(stranger).toBeTruthy();
    const target = emptyAccount();
    expect((await restoreArchive(db, target, archive)).status).toBe("done");
  });
});

describe("obnova z nepřátelského archivu, opravné kolo 2", () => {
  test("[SEC-005] prázdný řádek v auditu i v datech je chyba", async () => {
    await refused(
      editArchive(archive, (entries) => {
        entries["audit.jsonl"] = strToU8(`${strFromU8(entries["audit.jsonl"]!)}\n\n\n`);
      }),
      E.audit,
    );
    await refused(
      editArchive(archive, (entries) => {
        entries["data/customer.jsonl"] = strToU8(`\n${strFromU8(entries["data/customer.jsonl"]!)}`);
      }),
      E.row("customer"),
    );
  });

  test("[SEC-005] součet dat nad strop archivu je odmítnutý", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fakturan-scan-")), "zaloha.zip");
    writeFileSync(path, archive);
    const reason = await scanArchive(path, {}, { ...RESTORE_LIMITS, dataTotalBytes: 100 }).then(
      () => "prošlo",
      (error: Error) => error.message,
    );
    expect(reason).toBe(E.dataTooLarge);
  });

  test("[SEC-005] manifest projde levnou kontrolou závorek dřív než JSON.parse", () => {
    const manifest = unzipSync(archive)[MANIFEST_ENTRY]!;
    expect(() => prescanManifest(manifest, RESTORE_LIMITS)).not.toThrow();
    expect(() => prescanManifest(strToU8('{"a":[[[[[1]]]]]}'), RESTORE_LIMITS)).toThrow(E.manifest);
    expect(() =>
      prescanManifest(strToU8(`[${"{},".repeat(40)}{}]`), { ...RESTORE_LIMITS, entries: 10 }),
    ).toThrow(E.manifest);
    // Brackets inside strings are text, not structure.
    expect(() =>
      prescanManifest(strToU8('{"a":"[[[[[[[[[[\\"]]]]"}'), RESTORE_LIMITS),
    ).not.toThrow();
  });
});
