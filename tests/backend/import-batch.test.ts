import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { file, importBatch, invoice, job, schedulerState } from "@/server/db/schema";
import { userDir } from "@/server/files/store";
import {
  confirmBatch,
  editPreview,
  getPreview,
  previewBlobId,
  purgeStaleBatches,
  startParse,
} from "@/server/services/import-batch";
import { undoBatch } from "@/server/services/import-undo";
import { createTestDb } from "../helpers/db";
import { hostile, rawZip } from "../helpers/hostile-files";
import { webActor } from "../helpers/fixtures-mail";
import {
  committed,
  importOwner,
  isdoc,
  parsed,
  registerImportJobs,
  uploadBatch,
} from "../helpers/import";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-import-batch-")));

const db = createTestDb();
const NOW = new Date("2026-03-20T10:00:00Z");
let current = NOW;
const E = TEXTS.importing.errors;

beforeAll(() => registerImportJobs());
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

const batchOf = (id: string) => db.select().from(importBatch).where(eq(importBatch.id, id)).get()!;

describe("dávka importu", () => {
  test("[SEC-002] cizí dávku nejde zobrazit, upravit, potvrdit ani vrátit", async () => {
    const owner = importOwner(db, NOW);
    const stranger = importOwner(db, NOW);
    const { id, rows, batch } = await parsed(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    ]);
    const actor = webActor(stranger);

    expect(getPreview(stranger, id)).toBeNull();
    expect(() => startParse(actor, id)).toThrow(E.notFound);
    expect(() =>
      editPreview(actor, id, batch.revision, { kind: "skip", keys: [rows[0]!.key], skip: true }),
    ).toThrow(E.notFound);
    expect(() => confirmBatch(actor, id, batch.revision)).toThrow(E.notFound);
    expect(batchOf(id).status).toBe("ready");

    await committed(db, owner, id);
    expect(() => undoBatch(actor, id)).toThrow(E.notFound);
    expect(batchOf(id).status).toBe("done");
  });

  test("dvojí potvrzení založí jednu úlohu", async () => {
    const owner = importOwner(db, NOW);
    const { id, batch } = await parsed(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    ]);
    confirmBatch(webActor(owner), id, batch.revision);
    expect(() => confirmBatch(webActor(owner), id, batch.revision)).toThrow(E.status);
    expect(db.select().from(job).where(eq(job.kind, "import.commit")).all()).toHaveLength(1);
  });

  test("nepotvrzená dávka zmizí po 24 hodinách i se soubory", async () => {
    const owner = importOwner(db, NOW);
    const waiting = await uploadBatch(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    ]);
    const ready = await parsed(owner, [{ name: "b.isdoc", bytes: isdoc("faktura-eur.isdoc") }]);
    const done = await parsed(owner, [{ name: "c.isdoc", bytes: isdoc("verze-601.isdoc") }]);
    await committed(db, owner, done.id);
    const uploads = db.select().from(file).where(eq(file.importBatchId, waiting)).all();
    expect(uploads).toHaveLength(1);

    expect(purgeStaleBatches(new Date(NOW.getTime() + 23 * 3_600_000))).toBe(0);
    expect(purgeStaleBatches(new Date(NOW.getTime() + 25 * 3_600_000))).toBe(2);

    expect(
      db
        .select()
        .from(importBatch)
        .where(eq(importBatch.userId, owner))
        .all()
        .map((b) => b.id),
    ).toEqual([done.id]);
    expect(existsSync(join(userDir(owner), uploads[0]!.id))).toBe(false);
    expect(existsSync(join(userDir(owner), previewBlobId(ready.id)))).toBe(false);
    expect(db.select().from(file).where(eq(file.userId, owner)).all()).toEqual([]);
  });

  test("po potvrzení zmizí zdrojový soubor i náhled", async () => {
    const owner = importOwner(db, NOW);
    const { id } = await parsed(owner, [{ name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") }]);
    const upload = db.select().from(file).where(eq(file.importBatchId, id)).get()!;
    await committed(db, owner, id);
    expect(existsSync(join(userDir(owner), upload.id))).toBe(false);
    expect(existsSync(join(userDir(owner), previewBlobId(id)))).toBe(false);
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);
  });

  test("[SEC-005] archiv, který bezpečné čtení odmítne, skončí srozumitelnou chybou dávky", async () => {
    const owner = importOwner(db, NOW);
    const stored = rawZip([
      { name: "a.isdoc", data: isdoc("faktura-czk.isdoc"), method: 0, descriptor: true },
    ]);
    const { id, batch } = await parsed(owner, [{ name: "a.zip", bytes: stored }]);
    expect(batch.status).toBe("failed");
    expect(batch.error).toContain(TEXTS.importing.rejected.zip_corrupt);
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);

    const bomb = await parsed(owner, [{ name: "b.zip", bytes: hostile.lyingHeaderBomb() }]);
    expect(bomb.batch.status).toBe("failed");
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
  });
});
