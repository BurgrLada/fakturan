import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { ContentKind } from "@/lib/safe-input/limits";
import { sniffContent } from "@/lib/safe-input/limits";
import {
  importsRow,
  MAX_UPLOAD_BYTES,
  previewChangeSchema,
  rowBlocks,
  type Preview,
  type PreviewChange,
  type PreviewRow,
} from "@/lib/import-preview";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  customer,
  file,
  importBatch,
  type FileKind,
  type ImportBatch,
  type ImportBatchStatus,
  type ImportKind,
  type Job,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { readBlob, removeBlob, replaceBlob } from "../files/store";
import { UploadTooLarge, writeCapped } from "../files/upload";
import { enqueue, failJob } from "../jobs/queue";
import { kickWorker } from "../jobs/worker";
import { logger } from "../logger";
import { ServiceError, type Reader } from "./access";
import { Unchanged, unlessUnchanged } from "./invoices";
import { mutate } from "./mutation";

const E = TEXTS.importing.errors;
const M = TEXTS.importing.mapping;
const STALE_MS = 24 * 3_600_000;

// The upload and the preview carry personal data and are useless once the batch cannot go on.
const TEMPORARY_KINDS: FileKind[] = ["import_upload"];

const RUNNING: ImportBatchStatus[] = ["uploading", "mapping", "parsing", "ready", "committing"];
// Never purged by age: a commit holds documents, a parse still owns its files.
const PURGEABLE: ImportBatchStatus[] = ["uploading", "mapping", "ready", "failed"];

const ACCEPTED: Record<ImportKind, ContentKind[]> = {
  isdoc: ["zip", "pdf", "xml"],
  tabular: ["zip", "text"],
};

export const importActor = (userId: string): Actor => ({ userId, source: "import" });

export { UploadTooLarge };

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  return actor.userId;
}

export function previewBlobId(batchId: string): string {
  return `${batchId}-preview`;
}

export function findBatch(q: Reader, ownerId: string, batchId: string): ImportBatch {
  const row = q
    .select()
    .from(importBatch)
    .where(scoped(ownerId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
    .get();
  if (!row) throw new ServiceError(E.notFound);
  return row;
}

export function getBatch(ownerId: string, batchId: string): ImportBatch | null {
  return (
    db
      .select()
      .from(importBatch)
      .where(scoped(ownerId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .get() ?? null
  );
}

export function listBatches(ownerId: string, limit = 20): ImportBatch[] {
  return db
    .select()
    .from(importBatch)
    .where(scoped(ownerId).where(importBatch))
    .orderBy(desc(importBatch.createdAt))
    .limit(limit)
    .all();
}

export function readPreview(ownerId: string, batchId: string): Preview | null {
  try {
    return JSON.parse(readBlob(ownerId, previewBlobId(batchId)).toString("utf8")) as Preview;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writePreview(ownerId: string, batchId: string, preview: Preview): void {
  replaceBlob(ownerId, previewBlobId(batchId), Buffer.from(JSON.stringify(preview)));
}

export function getPreview(
  ownerId: string,
  batchId: string,
): { batch: ImportBatch; rows: PreviewRow[] } | null {
  const batch = getBatch(ownerId, batchId);
  if (!batch) return null;
  return { batch, rows: readPreview(ownerId, batchId)?.rows ?? [] };
}

export function createBatch(actor: Actor, kind: ImportKind): { id: string } {
  const userId = ownerOf(actor);
  return mutate(actor, "import.create", (tx, audit) => {
    const id = randomUUID();
    const now = clock.now();
    tx.insert(importBatch).values({ id, userId, kind, createdAt: now, updatedAt: now }).run();
    audit({
      entity: "import_batch",
      entityId: id,
      ownerId: userId,
      scope: "user",
      after: { kind },
    });
    return { id };
  });
}

export type UploadMeta = { name: string; declaredBytes: number | null };

// Display name only: the file is stored under a new UUID, never under anything the client sent.
function displayName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  // oxlint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return cleaned.slice(0, 120) || "soubor";
}

export async function storeUpload(
  actor: Actor,
  batchId: string,
  body: ReadableStream<Uint8Array> | null,
  meta: UploadMeta,
): Promise<{ fileId: string }> {
  const userId = ownerOf(actor);
  const batch = findBatch(db, userId, batchId);
  if (batch.status !== "uploading") throw new ServiceError(E.status);
  const remaining = MAX_UPLOAD_BYTES - batch.uploadedBytes;
  if (meta.declaredBytes !== null && meta.declaredBytes > remaining) throw new UploadTooLarge();

  const fileId = randomUUID();
  const stored = await writeCapped(userId, fileId, body, remaining);
  try {
    if (stored.size === 0) throw new ServiceError(E.empty);
    const kind = sniffContent(stored.head);
    if (!ACCEPTED[batch.kind].includes(kind)) {
      throw new ServiceError(batch.kind === "tabular" ? M.errors.unsupported : E.unsupported);
    }
    const name = displayName(meta.name);
    mutate(actor, "import.upload", (tx, audit) => {
      const current = findBatch(tx, userId, batchId);
      if (current.status !== "uploading") throw new ServiceError(E.status);
      if (current.kind === "tabular" && current.uploadedBytes > 0) {
        throw new ServiceError(M.errors.oneFile);
      }
      const uploadedBytes = current.uploadedBytes + stored.size;
      // Two uploads in parallel each saw the old total; the sum decides here.
      if (uploadedBytes > MAX_UPLOAD_BYTES) throw new UploadTooLarge();
      const now = clock.now();
      tx.insert(file)
        .values({
          id: fileId,
          userId,
          kind: "import_upload",
          mimeType: kind === "pdf" ? "application/pdf" : "application/octet-stream",
          name,
          size: stored.size,
          importBatchId: batchId,
          createdAt: now,
        })
        .run();
      tx.update(importBatch)
        .set({ uploadedBytes, updatedAt: now })
        .where(scoped(userId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
        .run();
      audit({
        entity: "import_batch",
        entityId: batchId,
        ownerId: userId,
        scope: "user",
        after: { size: stored.size, content: kind, uploadedBytes },
      });
    });
  } catch (error) {
    removeBlob(userId, fileId);
    throw error;
  }
  return { fileId };
}

export function uploadsOf(q: Reader, ownerId: string, batchId: string) {
  return (
    q
      .select()
      .from(file)
      .where(
        scoped(ownerId).where(file, (t) =>
          and(eq(t.importBatchId, batchId), eq(t.kind, "import_upload")),
        ),
      )
      // Upload order: rows of one batch share the clock tick, so only the rowid tells them apart.
      .orderBy(file.createdAt, sql`rowid`)
      .all()
  );
}

export function startParse(actor: Actor, batchId: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "import.parse", (tx, audit) => {
    const batch = findBatch(tx, userId, batchId);
    if (batch.status !== "uploading") throw new ServiceError(E.status);
    if (uploadsOf(tx, userId, batchId).length === 0) throw new ServiceError(E.empty);
    tx.update(importBatch)
      .set({ status: "parsing", progress: 0, updatedAt: clock.now() })
      .where(scoped(userId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .run();
    enqueue(tx, {
      kind: "import.parse",
      key: `import:parse:${batchId}`,
      userId,
      payload: { batchId },
    });
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId: userId,
      scope: "user",
      after: { status: "parsing" },
    });
  });
  kickWorker();
}

function applyChange(rows: PreviewRow[], change: PreviewChange, q: Reader, ownerId: string) {
  const wanted = new Set(change.keys);
  const today = calendarDateInPrague(clock.now());
  for (const row of rows) {
    if (!wanted.has(row.key)) continue;
    if (change.kind === "skip") {
      if (change.skip && row.status !== "skipped") {
        row.skippedFrom = row.status;
        row.status = "skipped";
      } else if (!change.skip && row.status === "skipped") {
        row.status = row.skippedFrom ?? "ok";
        row.skippedFrom = null;
      }
    } else if (change.kind === "paidOn") {
      if (row.paidMinor <= 0 || !row.document) continue;
      const day =
        change.mode === "date"
          ? change.date
          : change.mode === "due"
            ? (row.document.dueDate ?? row.document.issueDate)
            : row.document.issueDate;
      if (!day) throw new ServiceError(E.invalidChange);
      if (day > today) throw new ServiceError(E.futureDate);
      row.paidOn = day;
      row.dateEstimated = false;
    } else if (change.kind === "confirmOwn") {
      if (row.ownConfirmed === false) row.ownConfirmed = true;
    } else {
      if (change.customerId === null) {
        const name = row.document?.customer?.name ?? "";
        row.customerAction = { kind: "create", key: `row:${row.key}`, name };
        continue;
      }
      const chosen = q
        .select({ id: customer.id, name: customer.name })
        .from(customer)
        .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, change.customerId!)))
        .get();
      if (!chosen) throw new ServiceError(E.invalidChange);
      row.customerAction = { kind: "existing", customerId: chosen.id, name: chosen.name };
    }
  }
}

export function editPreview(
  actor: Actor,
  batchId: string,
  revision: number,
  raw: PreviewChange,
): { revision: number } {
  const userId = ownerOf(actor);
  const parsed = previewChangeSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(E.invalidChange);
  const change = parsed.data;
  const action = change.kind === "paidOn" ? "import.date_edit" : "import.preview_edit";
  return mutate(actor, action, (tx, audit) => {
    const batch = findBatch(tx, userId, batchId);
    if (batch.status !== "ready") throw new ServiceError(E.status);
    if (batch.revision !== revision) throw new ServiceError(E.stale);
    const preview = readPreview(userId, batchId);
    if (!preview) throw new ServiceError(E.notFound);
    applyChange(preview.rows, change, tx, userId);
    const next = batch.revision + 1;
    tx.update(importBatch)
      .set({ revision: next, updatedAt: clock.now() })
      .where(scoped(userId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .run();
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId: userId,
      scope: "user",
      after: {
        change: change.kind,
        rows: change.keys.length,
        ...(change.kind === "paidOn" ? { mode: change.mode } : {}),
      },
    });
    // Last in the transaction: a failed write takes the revision back with it.
    writePreview(userId, batchId, preview);
    return { revision: next };
  });
}

export function confirmBatch(actor: Actor, batchId: string, revision: number): void {
  const userId = ownerOf(actor);
  mutate(actor, "import.commit", (tx, audit) => {
    const batch = findBatch(tx, userId, batchId);
    if (batch.status !== "ready") throw new ServiceError(E.status);
    if (batch.revision !== revision) throw new ServiceError(E.stale);
    const rows = readPreview(userId, batchId)?.rows ?? [];
    if (rows.some(rowBlocks)) throw new ServiceError(E.blocked);
    if (!rows.some(importsRow)) throw new ServiceError(E.noDocuments);
    // Conditional on the state, so a double click cannot queue the commit twice.
    const moved = tx
      .update(importBatch)
      .set({ status: "committing", error: null, updatedAt: clock.now() })
      .where(
        scoped(userId).where(importBatch, (t, { and, eq }) =>
          and(eq(t.id, batchId), eq(t.status, "ready"), eq(t.revision, revision)),
        ),
      )
      .run();
    if (moved.changes === 0) throw new ServiceError(E.status);
    enqueue(tx, {
      kind: "import.commit",
      key: `import:commit:${batchId}:${revision}`,
      userId,
      payload: { batchId },
    });
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId: userId,
      scope: "user",
      after: { status: "committing", rows: rows.filter(importsRow).length },
    });
  });
  kickWorker();
}

// Rows go in the transaction, blobs after it: a rollback must not leave rows without their file.
export function takeFiles(
  tx: Tx,
  ownerId: string,
  batchId: string,
  kinds: FileKind[] = TEMPORARY_KINDS,
): string[] {
  return tx
    .delete(file)
    .where(
      scoped(ownerId).where(file, (t) => and(eq(t.importBatchId, batchId), inArray(t.kind, kinds))),
    )
    .returning({ id: file.id })
    .all()
    .map((row) => row.id);
}

export function removeBlobs(ownerId: string, ids: string[]): void {
  for (const id of ids) {
    try {
      removeBlob(ownerId, id);
    } catch (error) {
      logger.warn("Dočasný soubor importu nejde smazat", { err: error, fileId: id });
    }
  }
}

// A batch that already finished stays as it is; only one left half way becomes failed.
export function failBatch(ownerId: string, batchId: string, reason: string): void {
  const removed = unlessUnchanged(() =>
    mutate({ userId: ownerId, source: "system" }, "import.fail", (tx, audit) => {
      const failed = tx
        .update(importBatch)
        .set({ status: "failed", error: reason, updatedAt: clock.now() })
        .where(
          scoped(ownerId).where(importBatch, (t) =>
            and(eq(t.id, batchId), inArray(t.status, RUNNING)),
          ),
        )
        .returning({ id: importBatch.id })
        .get();
      if (!failed) throw new Unchanged<string[]>([]);
      const files = takeFiles(tx, ownerId, batchId, ["import_upload", "import_pdf"]);
      audit({
        entity: "import_batch",
        entityId: batchId,
        ownerId,
        scope: "user",
        after: { status: "failed", removedFiles: files.length },
      });
      return files;
    }),
  );
  removeBlobs(ownerId, [...removed, previewBlobId(batchId)]);
}

// R-8: an interrupted heavy run is never resumed. The user starts the import again.
export function recoverImportJob(row: Job): void {
  const batchId = row.payload.batchId;
  if (row.userId && typeof batchId === "string") {
    failBatch(row.userId, batchId, TEXTS.importing.interrupted);
  }
  failJob(row.id, row.lockedBy!, TEXTS.importing.interrupted);
}

// R-9: an unconfirmed batch carries personal data, so it does not outlive a day.
export function purgeStaleBatches(now: Date): number {
  const stale = db
    .select({ id: importBatch.id, userId: importBatch.userId })
    .from(importBatch)
    .where(
      and(
        inArray(importBatch.status, PURGEABLE),
        lt(importBatch.updatedAt, new Date(now.getTime() - STALE_MS)),
      ),
    )
    .all();
  for (const { id, userId } of stale) {
    const removed = mutate({ userId, source: "system" }, "import.purge", (tx, audit) => {
      const files = takeFiles(tx, userId, id, ["import_upload", "import_pdf"]);
      tx.delete(importBatch)
        .where(
          scoped(userId).where(importBatch, (t) => and(eq(t.id, id), inArray(t.status, PURGEABLE))),
        )
        .run();
      audit({
        entity: "import_batch",
        entityId: id,
        ownerId: userId,
        scope: "user",
        after: { removedFiles: files.length },
      });
      return files;
    });
    removeBlobs(userId, [...removed, previewBlobId(id)]);
  }
  return stale.length;
}
