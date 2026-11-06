import "server-only";
import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import {
  EXPORT_MIME_TYPES,
  exportFileName,
  exportInputSchema,
  type ExportInput,
} from "@/lib/export-filter";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { exportJob, file, type ExportJob, type ExportStatus, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { blobPath, removeBlob } from "../files/store";
import { enqueue, failJob } from "../jobs/queue";
import { kickWorker } from "../jobs/worker";
import { logger } from "../logger";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError, type Reader } from "./access";
import { Unchanged, unlessUnchanged } from "./invoices";
import { mutate } from "./mutation";
import { notify } from "./notifications";

const E = TEXTS.exporting.errors;

export const EXPORT_TTL_MS = 7 * 86_400_000;
const LIST_LIMIT = 20;
const RUNNING: ExportStatus[] = ["queued", "running"];
const MAX_RUNNING_EXPORTS = 3;

// Same message for a foreign, missing, unfinished or expired export: none may reveal the others.
export class ExportNotFoundError extends Error {
  constructor() {
    super(E.notFound);
    this.name = "ExportNotFoundError";
  }
}

const systemActor = (userId: string): Actor => ({ userId, source: "system" });

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  return actor.userId;
}

export function findExport(q: Reader, ownerId: string, id: string): ExportJob | undefined {
  return q
    .select()
    .from(exportJob)
    .where(scoped(ownerId).where(exportJob, (t, { eq: is }) => is(t.id, id)))
    .get();
}

export function createExport(actor: Actor, raw: ExportInput): { id: string } {
  const userId = ownerOf(actor);
  const parsed = exportInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  enforceRateLimit(actor, RATE_RULES.exportUser);
  const { kind, format, filter } = parsed.data;
  const id = randomUUID();
  mutate(actor, "export.create", (tx, audit) => {
    // One heavy lane serves the whole instance; the cap keeps one account from filling it.
    const running = tx
      .select({ id: exportJob.id })
      .from(exportJob)
      .where(scoped(userId).where(exportJob, (t) => inArray(t.status, RUNNING)))
      .limit(MAX_RUNNING_EXPORTS)
      .all();
    if (running.length >= MAX_RUNNING_EXPORTS) {
      throw new ServiceError(E.tooManyRunning(MAX_RUNNING_EXPORTS));
    }
    const now = clock.now();
    tx.insert(exportJob)
      .values({ id, userId, kind, format, filter, createdAt: now, updatedAt: now })
      .run();
    enqueue(tx, { kind: "export.run", key: `export:${id}`, userId, payload: { exportId: id } });
    audit({
      entity: "export_job",
      entityId: id,
      ownerId: userId,
      scope: "user",
      after: {
        kind,
        format,
        filters: Object.keys(filter).sort(),
        ...(filter.ids && { selected: filter.ids.length }),
      },
    });
  });
  kickWorker();
  return { id };
}

export type ExportListRow = Pick<
  ExportJob,
  | "id"
  | "kind"
  | "format"
  | "status"
  | "progress"
  | "progressTotal"
  | "reason"
  | "expiresAt"
  | "createdAt"
> & { downloadable: boolean };

export function listExports(ownerId: string): ExportListRow[] {
  const now = clock.now().getTime();
  return db
    .select()
    .from(exportJob)
    .where(scoped(ownerId).where(exportJob))
    .orderBy(desc(exportJob.createdAt), desc(exportJob.id))
    .limit(LIST_LIMIT)
    .all()
    .map((row) => {
      const expired = row.status === "done" && (row.expiresAt?.getTime() ?? 0) <= now;
      return {
        id: row.id,
        kind: row.kind,
        format: row.format,
        status: expired ? "expired" : row.status,
        progress: row.progress,
        progressTotal: row.progressTotal,
        reason: row.reason,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        downloadable: row.status === "done" && row.fileId !== null && !expired,
      };
    });
}

export type OpenedExport = { path: string; size: number; fileName: string; mimeType: string };

// Read from disk by the caller as a stream; only the path and the metadata pass through here.
export function openExport(actor: Actor, id: string): OpenedExport {
  const userId = ownerOf(actor);
  // Every download sends the whole file and writes an audit row, so a loop must not repeat it freely.
  enforceRateLimit(actor, RATE_RULES.exportDownloadUser);
  const row = findExport(db, userId, id);
  const now = clock.now();
  if (row?.status !== "done" || !row.fileId || !row.expiresAt || row.expiresAt <= now) {
    throw new ExportNotFoundError();
  }
  const fileId = row.fileId;
  const stored = db
    .select()
    .from(file)
    .where(scoped(userId).where(file, (t, { eq: is }) => is(t.id, fileId)))
    .get();
  if (!stored) throw new ExportNotFoundError();
  const path = blobPath(userId, stored.id);
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExportNotFoundError();
    throw error;
  }
  mutate(actor, "export.download", (_tx, audit) =>
    audit({
      entity: "export_job",
      entityId: id,
      ownerId: userId,
      scope: "user",
      after: { kind: row.kind, format: row.format, size },
    }),
  );
  return {
    path,
    size,
    fileName: exportFileName(row.kind, row.format, calendarDateInPrague(row.createdAt)),
    mimeType: EXPORT_MIME_TYPES[row.format],
  };
}

// The file row, the result and the notice commit together: the list never offers a half-written
// file, and false means the export was failed meanwhile and the caller removes the file.
export function finishExport(row: ExportJob, size: number, total: number): boolean {
  const ownerId = row.userId;
  return unlessUnchanged(() =>
    mutate(systemActor(ownerId), "export.finish", (tx, audit) => {
      const now = clock.now();
      tx.insert(file)
        .values({
          id: row.id,
          userId: ownerId,
          kind: "export",
          mimeType: EXPORT_MIME_TYPES[row.format],
          name: exportFileName(row.kind, row.format, calendarDateInPrague(row.createdAt)),
          size,
          createdAt: now,
        })
        .run();
      const moved = tx
        .update(exportJob)
        .set({
          status: "done",
          fileId: row.id,
          progress: total,
          progressTotal: total,
          expiresAt: new Date(now.getTime() + EXPORT_TTL_MS),
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          scoped(ownerId).where(exportJob, (t, { and: all, eq: is }) =>
            all(is(t.id, row.id), is(t.status, "running")),
          ),
        )
        .run();
      if (moved.changes === 0) throw new Unchanged(false);
      notify(tx, {
        userId: ownerId,
        kind: "export_ready",
        dedupeKey: `export:${row.id}`,
        params: {
          label: `${TEXTS.exporting.kinds[row.kind]}, ${TEXTS.exporting.formats[row.format]}`,
        },
        entity: { type: "export", id: row.id },
      });
      audit({
        entity: "export_job",
        entityId: row.id,
        ownerId,
        scope: "user",
        after: { status: "done", kind: row.kind, format: row.format, count: total, size },
      });
      return true;
    }),
  );
}

// Ends a queued or running export; the half-written file, if any, goes with it. A finished export
// is left alone, so a late recovery cannot take a delivered result away.
export function failExport(ownerId: string, id: string, reason: string): void {
  const failed = unlessUnchanged(() =>
    mutate(systemActor(ownerId), "export.fail", (tx, audit) => {
      const moved = tx
        .update(exportJob)
        .set({ status: "failed", reason, finishedAt: clock.now(), updatedAt: clock.now() })
        .where(
          scoped(ownerId).where(exportJob, (t, { and: all, eq: is }) =>
            all(is(t.id, id), inArray(t.status, RUNNING)),
          ),
        )
        .returning({ kind: exportJob.kind, format: exportJob.format })
        .get();
      if (!moved) throw new Unchanged(false);
      audit({
        entity: "export_job",
        entityId: id,
        ownerId,
        scope: "user",
        after: { status: "failed", kind: moved.kind, format: moved.format },
      });
      return true;
    }),
  );
  if (failed) removeResult(ownerId, id);
}

// The result is written under the export's own id, so recovery finds it without a file row.
export function removeResult(ownerId: string, id: string): void {
  try {
    const path = blobPath(ownerId, id);
    rmSync(path, { force: true });
    rmSync(`${path}.part`, { force: true });
  } catch (error) {
    logger.warn("Rozepsaný export se nepodařilo odstranit", { exportId: id, error });
  }
}

// R-8: an interrupted export is never resumed; the person starts it again.
export function recoverExportJob(row: Job): void {
  const exportId = row.payload.exportId;
  if (row.userId && typeof exportId === "string") {
    failExport(row.userId, exportId, TEXTS.exporting.interrupted);
  }
  failJob(row.id, row.lockedBy!, TEXTS.exporting.interrupted);
}

// R-23: after 7 days the file carries personal data nobody asked to keep; the row stays as a record.
export function purgeExpiredExports(now: Date): number {
  const expired = db
    .select({ id: exportJob.id, userId: exportJob.userId, fileId: exportJob.fileId })
    .from(exportJob)
    .where(and(eq(exportJob.status, "done"), lte(exportJob.expiresAt, now)))
    .all();
  for (const { id, userId, fileId } of expired) {
    const removed = unlessUnchanged(() =>
      mutate(systemActor(userId), "export.purge", (tx, audit) => {
        const moved = tx
          .update(exportJob)
          .set({ status: "expired", fileId: null, updatedAt: clock.now() })
          .where(
            scoped(userId).where(exportJob, (t, { and: all, eq: is }) =>
              all(is(t.id, id), is(t.status, "done")),
            ),
          )
          .run();
        if (moved.changes === 0) throw new Unchanged<string | null>(null);
        if (fileId) {
          tx.delete(file)
            .where(scoped(userId).where(file, (t, { eq: is }) => is(t.id, fileId)))
            .run();
        }
        audit({
          entity: "export_job",
          entityId: id,
          ownerId: userId,
          scope: "user",
          after: { status: "expired" },
        });
        return fileId;
      }),
    );
    if (removed) {
      try {
        removeBlob(userId, removed);
      } catch (error) {
        logger.warn("Soubor exportu se nepodařilo odstranit", { exportId: id, error });
      }
    }
  }
  return expired.length;
}
