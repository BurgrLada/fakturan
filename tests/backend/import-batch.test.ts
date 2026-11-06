import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { setClockForTests } from "@/server/clock";
import { file, importBatch, invoice, job, schedulerState } from "@/server/db/schema";
import { readBlob, userDir } from "@/server/files/store";
import { drainHeavy } from "@/server/jobs/worker";
import {
  confirmBatch,
  createBatch,
  discardBatch,
  editPreview,
  getPreview,
  previewBlobId,
  purgeStaleBatches,
  startParse,
} from "@/server/services/import-batch";
import { undoBatch } from "@/server/services/import-undo";
import { createTestDb } from "../helpers/db";
import { hostile, pdfWithEmbedded, rawZip } from "../helpers/hostile-files";
import { webActor } from "../helpers/fixtures-mail";
import {
  committed,
  importOwner,
  isdoc,
  parsed,
  registerImportJobs,
  tabularUploaded,
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
    expect(batch.error).toContain(TEXTS.importing.rejected.zip_stored_descriptor);
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);

    const bomb = await parsed(owner, [{ name: "b.zip", bytes: hostile.lyingHeaderBomb() }]);
    expect(bomb.batch.status).toBe("failed");
    expect(db.select().from(invoice).where(eq(invoice.userId, owner)).all()).toEqual([]);
  });
  test("účet nemá víc než 5 rozpracovaných dávek", async () => {
    const owner = importOwner(db, NOW);
    const done = await parsed(owner, [{ name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") }]);
    await committed(db, owner, done.id);
    for (let i = 0; i < 5; i++) createBatch(webActor(owner), i % 2 ? "tabular" : "isdoc");
    expect(() => createBatch(webActor(owner), "isdoc")).toThrow(E.tooManyOpen(5));
    const other = importOwner(db, NOW);
    expect(createBatch(webActor(other), "isdoc").id).toBeTruthy();
  });

  test("dávka zaseknutá ve zpracování se po 48 hodinách označí jako selhaná", async () => {
    const owner = importOwner(db, NOW);
    const id = await uploadBatch(owner, [{ name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") }]);
    startParse(webActor(owner), id);
    current = new Date(NOW.getTime() + 47 * 3_600_000);
    purgeStaleBatches(current);
    expect(batchOf(id).status).toBe("parsing");
    current = new Date(NOW.getTime() + 49 * 3_600_000);
    purgeStaleBatches(current);
    expect(batchOf(id)).toMatchObject({ status: "failed", error: E.stuck });
    expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);
  });

  test("ZIP se dvěma položkami stejného jména nepřiloží cizí PDF", async () => {
    const owner = importOwner(db, NOW);
    const first = pdfWithEmbedded(isdoc("faktura-czk.isdoc"));
    const second = pdfWithEmbedded(isdoc("faktura-eur.isdoc"));
    const zip = rawZip([
      { name: "doklad.pdf", data: first },
      { name: "doklad.pdf", data: second },
    ]);
    const { rows, batch } = await parsed(owner, [{ name: "a.zip", bytes: zip }]);
    expect(rows.map((row) => row.document?.number)).toEqual(["2026-0001"]);
    expect(batch.error).toContain(TEXTS.importing.rows.duplicateEntry("doklad.pdf"));
    expect(new Uint8Array(readBlob(owner, rows[0]!.pdfFileId!))).toEqual(first);
  });
  test("rozpracovanou dávku jde zahodit, rozběhnuté ani hotové ne", async () => {
    const owner = importOwner(db, NOW);
    const actor = webActor(owner);
    const uploading = await uploadBatch(owner, [
      { name: "a.isdoc", bytes: isdoc("faktura-czk.isdoc") },
    ]);
    const mapping = await tabularUploaded(
      owner,
      "z.csv",
      new TextEncoder().encode("Název\nAlfa\n"),
    );
    const ready = await parsed(owner, [{ name: "b.isdoc", bytes: isdoc("faktura-eur.isdoc") }]);
    for (const id of [uploading, mapping, ready.id]) {
      discardBatch(actor, id);
      expect(batchOf(id)).toMatchObject({ status: "failed", error: E.discarded });
      expect(db.select().from(file).where(eq(file.importBatchId, id)).all()).toEqual([]);
      expect(existsSync(join(userDir(owner), previewBlobId(id)))).toBe(false);
    }

    const committing = await parsed(owner, [{ name: "c.isdoc", bytes: isdoc("verze-601.isdoc") }]);
    confirmBatch(actor, committing.id, committing.batch.revision);
    expect(() => discardBatch(actor, committing.id)).toThrow(E.status);
    await drainHeavy("w");
    expect(batchOf(committing.id).status).toBe("done");
    expect(() => discardBatch(actor, committing.id)).toThrow(E.status);
    expect(() => discardBatch(webActor(importOwner(db, NOW)), uploading)).toThrow(E.notFound);

    for (let i = 0; i < 5; i++) createBatch(actor, "isdoc");
    expect(() => createBatch(actor, "isdoc")).toThrow(E.tooManyOpen(5));
    const [open] = db
      .select()
      .from(importBatch)
      .where(eq(importBatch.userId, owner))
      .all()
      .filter((b) => b.status === "uploading");
    discardBatch(actor, open!.id);
    expect(createBatch(actor, "isdoc").id).toBeTruthy();
  });
});
