import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { TEXTS } from "@/lib/texts";
import { clock } from "../clock";
import type { Tx } from "../db";
import { file, importBatch, type FileKind, type ImportBatchStatus, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { removeBlob } from "../files/store";
import { failJob } from "../jobs/queue";
import { logger } from "../logger";
import { Unchanged, unlessUnchanged } from "./invoices";
import { mutate } from "./mutation";

// The upload and the preview carry personal data and are useless once the batch cannot go on.
const TEMPORARY_KINDS: FileKind[] = ["import_upload"];

const RUNNING: ImportBatchStatus[] = ["uploading", "mapping", "parsing", "ready", "committing"];

// Rows go in the transaction, blobs after it: a rollback must not leave rows without their file.
export function takeTemporaryFiles(tx: Tx, ownerId: string, batchId: string): string[] {
  return tx
    .delete(file)
    .where(
      scoped(ownerId).where(file, (t) =>
        and(eq(t.importBatchId, batchId), inArray(t.kind, TEMPORARY_KINDS)),
      ),
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
        .returning({ id: importBatch.id, status: importBatch.status })
        .get();
      if (!failed) throw new Unchanged<string[]>([]);
      const files = takeTemporaryFiles(tx, ownerId, batchId);
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
  removeBlobs(ownerId, removed);
}

// R-8: an interrupted heavy run is never resumed. The user starts the import again.
export function recoverImportJob(row: Job): void {
  const batchId = row.payload.batchId;
  if (row.userId && typeof batchId === "string") {
    failBatch(row.userId, batchId, TEXTS.importing.interrupted);
  }
  failJob(row.id, row.lockedBy!, TEXTS.importing.interrupted);
}
