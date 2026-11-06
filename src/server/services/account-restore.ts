import "server-only";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq, getTableColumns, lt, notExists, sql, type AnyColumn } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { BACKUP_VERSION, RESTORE_LIMITS } from "@/lib/backup-format";
import { InputRejected } from "@/lib/safe-input/limits";
import { TEXTS } from "@/lib/texts";
import pkg from "../../../package.json";
import type { Actor } from "../audit/context";
import { buildIdMap, remapIds } from "../backup/remap";
import { RestoreRejected, scanArchive, type ArchiveRow } from "../backup/restore-read";
import { BACKUP_TABLES, type BackupTable } from "../backup/tables";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  bankMailbox,
  dashboard,
  exportJob,
  file,
  job,
  preferences,
  unit,
  type Job,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { blobPath, removeBlob, removeTempDir, tempDir, writeBlob } from "../files/store";
import { moveExport } from "../jobs/export-progress";
import { enqueue, failJob } from "../jobs/queue";
import { kickWorker, yieldHeavy } from "../jobs/worker";
import { enforceRateLimit, ServiceError } from "./access";
import { RATE_RULES } from "../rate-limit";
import { accountDataProblems } from "./data-checks";
import { assertExportSlot, failExport, findExport, removeResult } from "./exports";
import { mutate } from "./mutation";
import { notify } from "./notifications";

const E = TEXTS.restore.errors;
const ID = /^[0-9a-f-]{36}$/;
const BLOB_LIST = "blobs.txt";
const INSERT_CHUNK = 50;
// Created by the app on its own for any account; a restore replaces them (R-32).
const AUTOMATIC_TABLES = new Set(["preferences", "unit", "dashboard", "dashboard_widget"]);
const FINISHED_BATCH = new Set(["done", "undone", "failed"]);

type Owned = SQLiteTable & { userId: AnyColumn };

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  return actor.userId;
}

// Empty means no row in any table of the registry, apart from the default dashboard, preferences
// and units the app creates by itself.
export function isAccountEmpty(tx: Tx, ownerId: string): boolean {
  for (const entry of BACKUP_TABLES) {
    if (AUTOMATIC_TABLES.has(entry.name)) continue;
    const table = entry.table as Owned;
    const found = tx
      .select({ one: sql<number>`1` })
      .from(table)
      .where(and(scoped(ownerId).where(table), entry.rows?.()))
      .limit(1)
      .get();
    if (found) return false;
  }
  // Not in the archive, but a mailbox set up before the restore would go on reading notices
  // against the restored documents while the text says everything is off.
  const mailbox = tx
    .select({ one: sql<number>`1` })
    .from(bankMailbox)
    .where(scoped(ownerId).where(bankMailbox))
    .get();
  if (mailbox) return false;
  const dashboards =
    tx.select({ n: count() }).from(dashboard).where(scoped(ownerId).where(dashboard)).get()?.n ?? 0;
  return dashboards <= 1;
}

export function assertRestoreAllowed(actor: Actor): void {
  enforceRateLimit(actor, RATE_RULES.restoreUser);
}

function insertRestore(tx: Tx, userId: string, id: string): void {
  const now = clock.now();
  tx.insert(exportJob)
    .values({
      id,
      userId,
      kind: "restore",
      format: "zip",
      filter: {},
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// Checked and recorded before a single byte is stored, so a filled account uploads nothing and an
// upload cut off midway is found again by purgeStaleRestores.
export function beginRestoreUpload(actor: Actor): { id: string } {
  const userId = ownerOf(actor);
  const id = randomUUID();
  mutate(actor, "account.restore_upload", (tx, audit) => {
    if (!isAccountEmpty(tx, userId)) throw new ServiceError(E.notEmpty);
    assertExportSlot(tx, userId);
    insertRestore(tx, userId, id);
    audit({ entity: "account_restore", entityId: id, ownerId: userId, scope: "user" });
  });
  return { id };
}

// The upload lies under the id of the restore, so a failed restore removes it like a half-written
// export.
export function startRestore(actor: Actor, uploadId: string): { id: string } {
  const userId = ownerOf(actor);
  if (!ID.test(uploadId) || !existsSync(blobPath(userId, uploadId))) {
    throw new ServiceError(E.notFound);
  }
  const size = statSync(blobPath(userId, uploadId)).size;
  if (size === 0) throw new ServiceError(E.empty);
  if (size > RESTORE_LIMITS.archiveBytes) throw new ServiceError(E.tooLarge);
  mutate(actor, "account.restore_start", (tx, audit) => {
    if (!isAccountEmpty(tx, userId)) throw new ServiceError(E.notEmpty);
    const begun = findExport(tx, userId, uploadId);
    if (begun && begun.kind !== "restore") throw new ServiceError(E.notFound);
    // Failed by purgeStaleRestores because the upload went silent for an hour.
    if (begun && begun.status !== "queued") throw new ServiceError(E.uploadExpired);
    if (!begun) {
      assertExportSlot(tx, userId);
      insertRestore(tx, userId, uploadId);
    }
    enqueue(tx, {
      kind: "restore.run",
      key: `restore:${uploadId}`,
      userId,
      payload: { exportId: uploadId },
    });
    audit({
      entity: "account_restore",
      entityId: uploadId,
      ownerId: userId,
      scope: "user",
      after: { size },
    });
  });
  kickWorker();
  return { id: uploadId };
}

const STALE_UPLOAD_MS = 3_600_000;

// Called while bytes arrive, so a slow upload of a large backup is not taken for an abandoned one.
export function touchRestoreUpload(ownerId: string, id: string): void {
  moveExport(ownerId, id, ["queued"], {});
}

// An upload whose request died before startRestore has a queued row and no job; an hour after its
// last written chunk it is failed, which also removes whatever part of the file reached the disk.
export function purgeStaleRestores(now: Date): number {
  const stale = db
    .select({ id: exportJob.id, userId: exportJob.userId })
    .from(exportJob)
    .where(
      and(
        eq(exportJob.kind, "restore"),
        eq(exportJob.status, "queued"),
        lt(exportJob.updatedAt, new Date(now.getTime() - STALE_UPLOAD_MS)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(job)
            .where(eq(job.key, sql`'restore:' || ${exportJob.id}`)),
        ),
      ),
    )
    .all();
  for (const { id, userId } of stale) failExport(userId, id, TEXTS.restore.interrupted);
  return stale.length;
}

// R-34: nothing restored may act by itself; switching automation on again is a person's decision.
function silenced(table: string, row: ArchiveRow): ArchiveRow {
  if (table === "automation_settings") {
    return {
      ...row,
      recurring_send: false,
      reminders: false,
      payment_receipt: false,
      advance_invoice: false,
      daily_digest: false,
      paused: false,
      reminders_open_since: null,
    };
  }
  if (table === "preferences") return { ...row, advance_final_mode: "draft" };
  if (table === "recurring_invoice") return { ...row, send_confirmed_at: null };
  if (table === "mail_settings") return { ...row, verified_at: null };
  if (table === "email_log" && (row.status === "queued" || row.status === "sending")) {
    return { ...row, status: "cancelled" };
  }
  if (table === "import_batch" && !FINISHED_BATCH.has(row.status as string)) {
    return { ...row, status: "failed" };
  }
  return row;
}

function insertValues(entry: BackupTable, row: ArchiveRow, ownerId: string) {
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(entry.table))) {
    const rule = entry.columns[column.name];
    if (rule === "owner") values[key] = ownerId;
    else if (rule === "omit" || !(column.name in row)) continue;
    else {
      const value = row[column.name];
      values[key] =
        column.columnType === "SQLiteTimestamp" && typeof value === "number"
          ? new Date(value)
          : value;
    }
  }
  return values;
}

type Prepared = {
  rows: Map<string, ArchiveRow[]>;
  auditFileId: string;
  auditBytes: number;
  files: number;
  sha256: string;
};

function newBlob(ownerId: string, dir: string, id: string, bytes: Uint8Array): void {
  // Listed before it exists, so a crash between the two still finds and removes it.
  appendFileSync(join(dir, BLOB_LIST), `${id}\n`);
  writeBlob(ownerId, id, Buffer.from(bytes));
}

function listedBlobs(dir: string): string[] {
  const path = join(dir, BLOB_LIST);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((id) => ID.test(id));
}

function removeNewBlobs(ownerId: string, id: string): void {
  for (const blob of listedBlobs(tempDir(ownerId, id, "restore"))) removeBlob(ownerId, blob);
}

async function prepare(run: { job: Job; ownerId: string; id: string }): Promise<Prepared> {
  const path = blobPath(run.ownerId, run.id);
  // First pass: limits, manifest, hashes and every row, and nothing is written yet.
  const ids = new Map<string, string[]>();
  await scanArchive(path, {
    rows: async (entry, rows) => {
      if (entry.columns.id === "id")
        ids.set(
          entry.name,
          rows.map((row) => row.id as string),
        );
      await yieldHeavy(run.job);
    },
    file: () => yieldHeavy(run.job),
  });
  const idMap = buildIdMap(ids);
  moveExport(run.ownerId, run.id, ["running"], {
    progressTotal: BACKUP_TABLES.length + (ids.get("file")?.length ?? 0),
  });
  const dir = tempDir(run.ownerId, run.id, "restore");
  mkdirSync(dir, { recursive: true });
  const prepared: Prepared = {
    rows: new Map(),
    auditFileId: randomUUID(),
    auditBytes: 0,
    files: 0,
    sha256: "",
  };
  let done = 0;
  // Second pass: the same checks again, then new ids and the blobs under them.
  const summary = await scanArchive(path, {
    rows: async (entry, rows) => {
      prepared.rows.set(
        entry.name,
        rows.map((row) => silenced(entry.name, remapIds(row, entry, idMap))),
      );
      moveExport(run.ownerId, run.id, ["running"], { progress: (done += 1) });
      await yieldHeavy(run.job);
    },
    file: async (oldId, bytes) => {
      newBlob(run.ownerId, dir, idMap.tables.get("file")!.get(oldId)!, bytes);
      prepared.files += 1;
      moveExport(run.ownerId, run.id, ["running"], { progress: (done += 1) });
      await yieldHeavy(run.job);
    },
    audit: (bytes) => {
      newBlob(run.ownerId, dir, prepared.auditFileId, bytes);
      prepared.auditBytes = bytes.length;
    },
  });
  prepared.sha256 = summary.sha256;
  return prepared;
}

function commit(ownerId: string, id: string, prepared: Prepared): void {
  const actor: Actor = { userId: ownerId, source: "import" };
  mutate(actor, "account.restore", (tx, audit) => {
    // A correction may come before its original; the check waits for the end of the transaction.
    tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    if (!isAccountEmpty(tx, ownerId)) throw new RestoreRejected(E.notEmpty);
    tx.delete(dashboard).where(scoped(ownerId).where(dashboard)).run();
    tx.delete(preferences).where(scoped(ownerId).where(preferences)).run();
    tx.delete(unit).where(scoped(ownerId).where(unit)).run();
    let total = 0;
    for (const entry of BACKUP_TABLES) {
      const rows = prepared.rows.get(entry.name) ?? [];
      total += rows.length;
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        const chunk = rows.slice(start, start + INSERT_CHUNK);
        tx.insert(entry.table)
          .values(chunk.map((row) => insertValues(entry, row, ownerId)) as never)
          .run();
      }
      // Inserted rows are no longer needed; the heap shrinks table by table during the commit.
      prepared.rows.delete(entry.name);
    }
    const now = clock.now();
    tx.insert(file)
      .values({
        id: prepared.auditFileId,
        userId: ownerId,
        kind: "audit_archive",
        mimeType: "application/x-ndjson",
        name: TEXTS.restore.auditFileName,
        size: prepared.auditBytes,
        createdAt: now,
      })
      .run();
    notify(tx, {
      userId: ownerId,
      kind: "backup_restored",
      dedupeKey: `restore:${id}`,
      params: {},
      entity: { type: "file", id: prepared.auditFileId },
    });
    if (accountDataProblems(tx, ownerId).length > 0) throw new RestoreRejected(E.inconsistent);
    const moved = tx
      .update(exportJob)
      .set({ status: "done", finishedAt: now, updatedAt: now })
      .where(
        scoped(ownerId).where(exportJob, (t, { and: all, eq: is }) =>
          all(is(t.id, id), is(t.status, "running")),
        ),
      )
      .run();
    if (moved.changes === 0) throw new Error("Obnova už neběží");
    audit({
      entity: "account_restore",
      entityId: id,
      ownerId,
      scope: "user",
      after: {
        v: BACKUP_VERSION,
        app: pkg.version,
        tables: total,
        files: prepared.files,
        sha256: prepared.sha256,
      },
    });
  });
}

function reasonOf(error: unknown): string | null {
  if (error instanceof RestoreRejected || error instanceof ServiceError) return error.message;
  if (error instanceof InputRejected) return E.archive;
  return null;
}

export async function runRestore(job: Job): Promise<void> {
  const ownerId = job.userId;
  const id = job.payload.exportId;
  if (!ownerId || typeof id !== "string") throw new Error("Úloha obnovy nemá vlastníka");
  const row = findExport(db, ownerId, id);
  if (row && row.kind !== "restore") throw new Error("Export nepatří do úlohy obnovy");
  if (!row || !moveExport(ownerId, id, ["queued"], { status: "running", progress: 0 })) return;
  try {
    const prepared = await prepare({ job, ownerId, id });
    try {
      commit(ownerId, id, prepared);
    } catch (error) {
      // Every ref was matched against the archive already; the deferred check at COMMIT is the
      // net for anything that still points nowhere.
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new RestoreRejected(E.references);
      }
      throw error;
    }
    removeResult(ownerId, id);
  } catch (error) {
    removeNewBlobs(ownerId, id);
    // The account was deleted meanwhile: its folder and rows are gone with it.
    if (!findExport(db, ownerId, id)) return;
    const reason = reasonOf(error);
    failExport(ownerId, id, reason ?? E.unexpected);
    if (reason === null) throw error;
  } finally {
    removeTempDir(ownerId, id, "restore");
  }
}

// R-8: a restore cut off before its commit leaves the account as it was; the blobs it wrote go.
export function recoverRestore(row: Job): void {
  const id = row.payload.exportId;
  if (row.userId && typeof id === "string") {
    const restore = findExport(db, row.userId, id);
    if (restore?.status !== "done") removeNewBlobs(row.userId, id);
    failExport(row.userId, id, TEXTS.restore.interrupted);
    removeResult(row.userId, id);
    removeTempDir(row.userId, id, "restore");
  }
  failJob(row.id, row.lockedBy!, TEXTS.restore.interrupted);
}
