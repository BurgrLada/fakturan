import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_ENTRY,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  dataEntry,
  fileEntry,
  MANIFEST_ENTRY,
  RESTORE_LIMITS,
  type BackupManifest,
  type RestoreLimits,
} from "@/lib/backup-format";
import { TEXTS } from "@/lib/texts";
import pkg from "../../../package.json";
import journal from "../../../drizzle/meta/_journal.json";
import type { Actor } from "../audit/context";
import { entryLimit } from "../backup/restore-read";
import {
  AUDIT_FILE,
  FILES_DIR,
  MissingBlob,
  snapshot,
  SnapshotTooLarge,
  type NodeStats,
  type Snapshot,
} from "../backup/snapshot";
import { BACKUP_TABLES, backupColumnsHash } from "../backup/tables";
import { clock } from "../clock";
import { db } from "../db";
import { exportJob, type Job } from "../db/schema";
import { blobPath, removeTempDir, tempDir } from "../files/store";
import { ExportTooLarge, zipFileWriter, type EntryStream } from "../files/zip-writer";
import { moveExport } from "../jobs/export-progress";
import { enqueue, failJob } from "../jobs/queue";
import { kickWorker, yieldHeavy } from "../jobs/worker";
import { logger } from "../logger";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import {
  assertExportSlot,
  failExport,
  findExport,
  finishExport,
  listBackups,
  removeResult,
} from "./exports";
import { mutate } from "./mutation";

const E = TEXTS.backup.errors;
const CHUNK = 1024 * 1024;

export { listBackups };

// What the delete form offers (ADM-009): the last finished backup and whether one is running.
export function lastBackupOf(ownerId: string): { lastBackupAt: Date | null; running: boolean } {
  const rows = listBackups(ownerId);
  const done = rows.find((row) => row.status === "done" || row.status === "expired");
  return {
    lastBackupAt: done?.finishedAt ?? null,
    running: rows.some((row) => row.status === "queued" || row.status === "running"),
  };
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  return actor.userId;
}

export function createBackup(actor: Actor): { id: string } {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.backupUser);
  const id = randomUUID();
  mutate(actor, "account.backup", (tx, audit) => {
    assertExportSlot(tx, userId);
    const now = clock.now();
    tx.insert(exportJob)
      .values({
        id,
        userId,
        kind: "backup",
        format: "zip",
        filter: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();
    enqueue(tx, { kind: "backup.run", key: `backup:${id}`, userId, payload: { exportId: id } });
    audit({
      entity: "account_backup",
      entityId: id,
      ownerId: userId,
      scope: "user",
      after: { format: BACKUP_FORMAT, v: BACKUP_VERSION },
    });
  });
  kickWorker();
  return { id };
}

type Run = { job: Job; ownerId: string; exportId: string; done: number };
type Digest = { sha256: string; size: number };

async function digest(run: Run, source: string): Promise<Digest> {
  const hash = createHash("sha256");
  let size = 0;
  const fd = openSync(source, "r");
  try {
    const block = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const read = readSync(fd, block, 0, CHUNK, null);
      if (read === 0) break;
      hash.update(block.subarray(0, read));
      size += read;
      await yieldHeavy(run.job);
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), size };
}

async function copyEntry(run: Run, stream: EntryStream, source: string): Promise<void> {
  const fd = openSync(source, "r");
  try {
    for (;;) {
      // A fresh buffer per block: the archive writer may still hold the previous one.
      const block = Buffer.allocUnsafe(CHUNK);
      const read = readSync(fd, block, 0, CHUNK, null);
      if (read === 0) break;
      stream.push(block.subarray(0, read));
      await yieldHeavy(run.job);
    }
  } finally {
    closeSync(fd);
  }
  stream.end();
  run.done += 1;
  moveExport(run.ownerId, run.exportId, ["running"], { progress: run.done });
  await yieldHeavy(run.job);
}

type Planned = { name: string; source: string; level: 0 | 6 };

// The manifest goes first, so a restore can check every entry against it as the entry arrives;
// the hashes therefore come from the snapshot files before the archive is written.
async function writeArchive(run: Run, dir: string, snap: Snapshot, path: string): Promise<number> {
  const createdAt = clock.now();
  const planned: Planned[] = [
    ...BACKUP_TABLES.map((entry) => ({
      name: dataEntry(entry.name),
      source: join(dir, `${entry.name}.jsonl`),
      level: 6 as const,
    })),
    ...snap.files.map((id) => ({
      name: fileEntry(id),
      source: join(dir, FILES_DIR, id),
      level: 0 as const,
    })),
    { name: AUDIT_ENTRY, source: join(dir, AUDIT_FILE), level: 6 },
  ];
  const entries: BackupManifest["entries"] = {};
  for (const item of planned) entries[item.name] = await digest(run, item.source);
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    app: pkg.version,
    migration: journal.entries.at(-1)!.tag,
    columns: backupColumnsHash(),
    createdAt: createdAt.toISOString(),
    counts: { tables: snap.tables, files: snap.files.length, audit: snap.audit },
    entries,
  };
  // Compact, so 4 MiB of manifest carries the entry cap of RESTORE_LIMITS.
  const text = JSON.stringify(manifest);
  const problem = restorableProblem(
    entries,
    manifest.counts,
    RESTORE_LIMITS,
    snap.longestLine,
    Buffer.byteLength(text),
    snap.nodes,
  );
  if (problem) throw new NotRestorable(problem);
  const zip = zipFileWriter(path, { mtime: createdAt });
  try {
    zip.addDeflated(MANIFEST_ENTRY, text);
    for (const item of planned) {
      await copyEntry(run, zip.deflatedEntry(item.name, item.level), item.source);
    }
    return zip.close();
  } catch (error) {
    zip.abort();
    throw error;
  }
}

type EntrySizes = Record<string, { size: number; sha256?: string }>;
type Counts = { tables: Record<string, number>; files: number; audit: number };

// R-35: a backup the restore would refuse is never written, so nobody deletes an account trusting
// a file that cannot come back. Returns the refusal, or null when the archive fits.
export function restorableProblem(
  entries: EntrySizes,
  counts: Counts,
  limits: RestoreLimits = RESTORE_LIMITS,
  longestLine = 0,
  manifestBytes = 0,
  nodes: NodeStats = { nodes: 0, containers: 0, lineContainers: 0, lineDepth: 0 },
): string | null {
  const names = Object.keys(entries);
  const sizes = names.map((name) => entries[name]!.size);
  const tableLines = Object.values(counts.tables);
  const dataBytes = names
    .filter((name) => name.startsWith("data/"))
    .reduce((sum, name) => sum + entries[name]!.size, 0);
  const tooLarge =
    names.length + 1 > limits.entries ||
    dataBytes > limits.dataTotalBytes ||
    names.some((name) => entries[name]!.size > entryLimit(name, limits)) ||
    sizes.reduce((sum, size) => sum + size, 0) + manifestBytes > limits.archiveBytes ||
    manifestBytes > limits.manifestBytes;
  const tooManyLines =
    tableLines.some((n) => n > limits.maxLinesPerTable) ||
    tableLines.reduce((sum, n) => sum + n, 0) + counts.audit > limits.maxLines ||
    longestLine > limits.maxLineBytes ||
    nodes.nodes > limits.maxNodes ||
    nodes.containers > limits.maxContainers ||
    nodes.lineContainers > limits.maxLineContainers ||
    nodes.lineDepth > limits.maxLineDepth;
  return tooLarge || tooManyLines ? E.notRestorable : null;
}

class NotRestorable extends Error {}

function reasonOf(error: unknown): string | null {
  if (error instanceof NotRestorable || error instanceof SnapshotTooLarge) return E.notRestorable;
  if (error instanceof MissingBlob) return E.missingFile;
  if (error instanceof ServiceError) return error.message;
  if (error instanceof ExportTooLarge) return E.tooLarge;
  return null;
}

export async function runBackup(job: Job): Promise<void> {
  const ownerId = job.userId;
  const exportId = job.payload.exportId;
  if (!ownerId || typeof exportId !== "string") throw new Error("Úloha zálohy nemá vlastníka");
  const row = findExport(db, ownerId, exportId);
  if (row && row.kind !== "backup") throw new Error("Export nepatří do úlohy zálohy");
  if (!row || !moveExport(ownerId, exportId, ["queued"], { status: "running", progress: 0 })) {
    return;
  }
  const run: Run = { job, ownerId, exportId, done: 0 };
  const dir = tempDir(ownerId, exportId);
  // Written under the backup's own id; only finishExport makes it a file of the account.
  const path = blobPath(ownerId, exportId);
  let size: number;
  let snap: Snapshot;
  try {
    const started = performance.now();
    snap = snapshot(ownerId, dir);
    logger.info("Snímek účtu pro zálohu", {
      exportId,
      ms: Math.round(performance.now() - started),
      files: snap.files.length,
    });
    const total = BACKUP_TABLES.length + snap.files.length + 1;
    moveExport(ownerId, exportId, ["running"], { progressTotal: total });
    size = await writeArchive(run, dir, snap, path);
  } catch (error) {
    // The account was deleted meanwhile: its folder and rows are gone, nothing is left to report.
    if (!findExport(db, ownerId, exportId)) return;
    const reason = reasonOf(error);
    failExport(ownerId, exportId, reason ?? E.unexpected);
    // A code failure leaves a dead job and a report; a refusal is an answer, not an incident.
    if (reason === null) throw error;
    return;
  } finally {
    removeTempDir(ownerId, exportId);
  }
  const total = run.done;
  let finished: boolean;
  try {
    finished = finishExport(row, size, total, {
      tables: Object.values(snap.tables).reduce((sum, n) => sum + n, 0),
      files: snap.files.length,
      audit: snap.audit,
    });
  } catch (error) {
    if (!findExport(db, ownerId, exportId)) return;
    failExport(ownerId, exportId, E.unexpected);
    throw error;
  }
  if (!finished) removeResult(ownerId, exportId);
}

// R-8: an interrupted backup is never resumed; its snapshot and half-written archive go with it.
export function recoverBackupJob(row: Job): void {
  const exportId = row.payload.exportId;
  if (row.userId && typeof exportId === "string") {
    failExport(row.userId, exportId, TEXTS.backup.interrupted);
    removeTempDir(row.userId, exportId);
  }
  failJob(row.id, row.lockedBy!, TEXTS.backup.interrupted);
}
