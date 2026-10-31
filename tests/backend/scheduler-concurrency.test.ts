import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createDb, runMigrations } from "@/server/db";
import { job } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/queue";
import { runJobWorkers } from "../helpers/run-workers";

const dir = mkdtempSync(join(tmpdir(), "fakturan-jobs-"));
const databasePath = join(dir, "jobs.db");
const shared = createDb(databasePath);
runMigrations(shared);

afterAll(() => {
  shared.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("souběh", () => {
  test("[TST-010] 8 souběžných workerů vykoná každou ze 100 úloh právě jednou", async () => {
    shared.transaction((tx) => {
      for (let i = 0; i < 100; i += 1) {
        enqueue(tx, { kind: "mail.send", key: `run-${i}`, userId: null, payload: { i } });
      }
    });
    const claimed = await runJobWorkers<string[]>(
      Array.from({ length: 8 }, (_, i) => ({ mode: "claim", worker: `w${i}` })),
      databasePath,
    );
    const ids = claimed.flat();
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    const rows = shared.select().from(job).all();
    expect(rows.every((row) => row.status === "done" && row.attempts === 1)).toBe(true);
    expect(claimed.filter((chunk) => chunk.length > 0).length).toBeGreaterThan(1);
  }, 60_000);

  test("[TST-010] souběžné ticky nezaloží duplicitu", async () => {
    shared.delete(job).run();
    const results = await runJobWorkers<{ ran: boolean }[]>(
      Array.from({ length: 8 }, (_, i) => ({ mode: "tick", worker: `h${i}`, ticks: 3 })),
      databasePath,
    );
    const winners = results.filter((ticks) => ticks.some((r) => r.ran));
    expect(winners).toHaveLength(1);
    expect(winners[0].every((r) => r.ran)).toBe(true);

    const rows = shared.select().from(job).all();
    const daily = rows.filter((row) => row.key.startsWith("daily:"));
    expect(daily).toHaveLength(1);
    const runs = rows.filter((row) => row.key.startsWith("run:"));
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((row) => row.key.split(":")[1])).size).toBe(1);
    expect(rows.every((row) => row.status === "done")).toBe(true);
  }, 60_000);
});
