import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { job, schedulerState, user } from "@/server/db/schema";
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
