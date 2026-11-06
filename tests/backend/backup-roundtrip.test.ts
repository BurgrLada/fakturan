import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eachSpooled, spoolWriter } from "@/server/backup/spool";
import { setClockForTests } from "@/server/clock";
import { customer, job, schedulerState, user } from "@/server/db/schema";
import { registerJob } from "@/server/jobs/registry";
import { recoverBackupJob, runBackup } from "@/server/services/account-backup";
import { recoverRestore, runRestore } from "@/server/services/account-restore";
import {
  asRestored,
  backupArchive,
  canonicalAccount,
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
    const seeded = seedRichAccount(db, source, NOW);
    // One line well over the 1 MiB read block of the spool files.
    const note = `Poznámka ${"ř".repeat(700_000)} konec`;
    db.update(customer).set({ note }).where(eq(customer.id, seeded.customerId)).run();
    const expected = asRestored(canonicalAccount(db, source));
    const target = emptyAccount();
    const row = await restoreArchive(db, target, await backupArchive(db, source));
    expect(row.status).toBe("done");
    expect(canonicalAccount(db, target)).toEqual(expected);
    expect(db.select().from(customer).where(eq(customer.userId, target)).get()!.note).toBe(note);
    assertConsistent(db, target);
  });
});
