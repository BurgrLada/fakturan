import "server-only";
import { inArray } from "drizzle-orm";
import { clock } from "../clock";
import { db } from "../db";
import { exportJob, type ExportStatus } from "../db/schema";
import { scoped } from "../db/scoped";

// Start and progress are the job's own state like the queue row, not account data, so they skip
// the audit; creating, finishing, failing and downloading an export are audited in the service.
export function moveExport(
  ownerId: string,
  id: string,
  from: ExportStatus[],
  fields: Partial<typeof exportJob.$inferInsert>,
): boolean {
  const moved = db
    .update(exportJob)
    .set({ ...fields, updatedAt: clock.now() })
    .where(
      scoped(ownerId).where(exportJob, (t, { and, eq }) =>
        and(eq(t.id, id), inArray(t.status, from)),
      ),
    )
    .run();
  return moved.changes > 0;
}
