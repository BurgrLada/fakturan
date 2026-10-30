import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createDb, runMigrations, type Db } from "@/server/db";

export function createTestDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "fakturan-test-"));
  const db = createDb(join(dir, "test.db"));
  runMigrations(db);
  afterAll(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}
