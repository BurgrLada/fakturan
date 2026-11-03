import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { customer, file, importBatch, invoice, job, schedulerState } from "@/server/db/schema";
import { claimNext } from "@/server/jobs/queue";
import { drainHeavy, recoverInterrupted } from "@/server/jobs/worker";
import { confirmBatch } from "@/server/services/import-batch";
import { createTestDb } from "../helpers/db";
import { webActor } from "../helpers/fixtures-mail";
import { importOwner, isdoc, parsed, registerImportJobs } from "../helpers/import";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-crash-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");

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
  db.run(sql`DROP TRIGGER IF EXISTS fail_payment`);
});

const batchOf = (id: string) => db.select().from(importBatch).where(eq(importBatch.id, id)).get()!;

async function readyBatch(owner: string) {
  return parsed(owner, [
    { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    { name: "b.isdoc", bytes: isdoc("verze-601.isdoc") },
    { name: "c.isdoc", bytes: isdoc("uhrazena.isdoc") },
  ]);
}

describe("pád při ukládání", () => {
  test("[TST-017] pád uvnitř import.commit nezanechá částečnou dávku", async () => {
    const owner = importOwner(db, NOW);
    const { id, batch } = await readyBatch(owner);
    // The last document's payment fails, after the other documents and the new customer.
    db.run(
      sql.raw(`CREATE TRIGGER fail_payment BEFORE INSERT ON payment
        WHEN NEW.user_id = '${owner}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`),
    );
    confirmBatch(webActor(owner), id, batch.revision);

    await drainHeavy("w");

    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
    expect(db.select().from(customer).where(eq(customer.userId, owner)).all()).toEqual([]);
    expect(batchOf(id)).toMatchObject({
      status: "failed",
      error: TEXTS.importing.errors.unexpected,
    });
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);
    expect(db.select().from(job).where(eq(job.kind, "import.commit")).get()!.status).toBe("dead");
  });

  test("[TST-017] ukončení procesu během import.commit dávku označí failed", async () => {
    const owner = importOwner(db, NOW);
    const { id, batch } = await readyBatch(owner);
    confirmBatch(webActor(owner), id, batch.revision);
    claimNext("mrtvý", "heavy");

    recoverInterrupted("nový");

    expect(batchOf(id)).toMatchObject({ status: "failed", error: TEXTS.importing.interrupted });
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);
  });
});
