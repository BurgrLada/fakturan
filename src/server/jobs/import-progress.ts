import "server-only";
import { and, eq } from "drizzle-orm";
import { clock } from "../clock";
import { db } from "../db";
import { importBatch } from "../db/schema";

// Progress is the job's own state like the queue row, not account data, so it skips the audit
// that every change of the batch itself goes through.
export function setImportProgress(ownerId: string, batchId: string, progress: number): void {
  db.update(importBatch)
    .set({ progress, updatedAt: clock.now() })
    .where(and(eq(importBatch.id, batchId), eq(importBatch.userId, ownerId)))
    .run();
}
