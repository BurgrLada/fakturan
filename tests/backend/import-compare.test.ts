import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { job, schedulerState } from "@/server/db/schema";
import { databaseTotals, formatComparison, sourceTotals } from "../../scripts/import-compare-core";
import { createTestDb } from "../helpers/db";
import { committed, importOwner, isdoc, parsed, registerImportJobs } from "../helpers/import";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-compare-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeAll(() => registerImportJobs());
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

describe("porovnání importu", () => {
  test("[TST-020] skript vypíše součty a nic nezapisuje", async () => {
    const owner = importOwner(db, NOW);
    const names = ["faktura-czk.isdoc", "faktura-eur.isdoc", "dobropis.isdoc", "zalohova.isdoc"];
    const files = names.map((name) => ({ name, bytes: isdoc(name) }));
    await committed(db, owner, (await parsed(owner, files)).id);
    const dir = mkdtempSync(join(tmpdir(), "fakturan-copy-"));
    const copy = join(dir, "kopie.sqlite");
    await db.$client.backup(copy);
    const before = sha(copy);

    const zip = zipSync(Object.fromEntries(files.map((item) => [item.name, item.bytes])));
    const output = formatComparison(await sourceTotals(zip), databaseTotals(copy, owner));

    expect(sha(copy)).toBe(before);
    expect(readdirSync(dir).filter((name) => name !== "kopie.sqlite")).toEqual([]);
    const lines = output.split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(line).toMatch(/^\d{4} [A-Z]{3} \| \d+, -?\d+\.\d{2} \| \d+, -?\d+\.\d{2} \| ano$/);
    // Only counts and sums: no number, customer or supplier of a document.
    expect(output).not.toMatch(/2026-0001|Vzorová|Zkušební/);
  });
});
