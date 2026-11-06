import "server-only";
import {
  closeSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { and, asc, getTableColumns, gt, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  jsonBytes,
  jsonBytesFor,
  jsonNodes,
  RESTORE_LIMITS,
  rowBytesFor,
  type RestoreLimits,
} from "@/lib/backup-format";
import { TEXTS } from "@/lib/texts";
import { db, type Tx } from "../db";
import { auditLog, file } from "../db/schema";
import { scoped } from "../db/scoped";
import { blobPath } from "../files/store";
import { isForeignActor } from "../services/audit-read";
import {
  createMemoryGuard,
  lineCost,
  MEMORY_LIMITS,
  RestoreRejected,
  type MemoryGuard,
} from "./memory-guard";
import { BACKUP_TABLES, FOLDED_FILES, type BackupTable } from "./tables";

const PAGE = 500;
// A row with a JSON column may take up to maxRowBytes, so a page of them stays near 16 MiB.
const PAGE_BYTES = 16 * 1024 * 1024;
const LINE_BUFFER = 64 * 1024;
export const AUDIT_FILE = "audit.jsonl";
export const FILES_DIR = "files";

// A file row of the account without its blob: the archive would silently miss it.
export class MissingBlob extends Error {}

// More than a restore accepts; stopped while reading instead of after the archive is written.
// `reason`, when set, names what blocks the backup, so the person can shorten it.
export class SnapshotTooLarge extends Error {
  reason: string | null;
  constructor(reason: string | null = null) {
    super(reason ?? "SnapshotTooLarge");
    this.reason = reason;
  }
}

// The row a person can find and shorten: a template or plan by name, a document by number.
function blocking(table: string, row: Record<string, unknown>): string {
  const B = TEXTS.backup.blocking;
  const what =
    table === "invoice_template"
      ? B.template(String(row.name))
      : table === "recurring_invoice"
        ? B.plan(String(row.name))
        : table === "invoice"
          ? B.invoice(String(row.number ?? row.id))
          : B.row(table);
  return TEXTS.backup.errors.documentTooLarge(what);
}

type Owned = SQLiteTable & { userId: AnyColumn };

export type Snapshot = {
  tables: Record<string, number>;
  files: string[];
  audit: number;
  longestLine: number;
  nodes: NodeStats;
};

export type NodeStats = {
  nodes: number;
  containers: number;
  lineContainers: number;
  lineDepth: number;
};

type LineStats = { longest: number } & NodeStats;

type Lines = {
  add(row: Record<string, unknown>): number;
  addLine(line: string): number;
  close(): void;
};

// Counted as the restore will count them: the nodes of rows add up, those of the audit do not.
function lineFile(
  path: string,
  stats: LineStats,
  watch: Watch,
  limits: RestoreLimits,
  retained = true,
): Lines {
  const fd = openSync(path, "wx");
  let pending = "";
  const flush = () => {
    if (pending) writeSync(fd, pending);
    pending = "";
  };
  const addLine = (line: string) => {
    const bytes = Buffer.byteLength(line);
    if (!retained && bytes > limits.maxLineBytes) throw new SnapshotTooLarge();
    const shape = jsonNodes(line);
    watch(bytes, lineCost(bytes, shape));
    stats.lineContainers = Math.max(stats.lineContainers, shape.containers);
    stats.lineDepth = Math.max(stats.lineDepth, shape.depth);
    if (retained) {
      stats.nodes += shape.nodes;
      stats.containers += shape.containers;
    }
    pending += `${line}\n`;
    if (pending.length >= LINE_BUFFER) flush();
    return bytes;
  };
  return {
    add(row) {
      return addLine(JSON.stringify(row));
    },
    addLine,
    close() {
      try {
        flush();
      } finally {
        closeSync(fd);
      }
    },
  };
}

// Plain JSON values: a timestamp as epoch milliseconds, a flag as a boolean, JSON as JSON.
function plain(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

// Pages by rowid inside one read transaction, so every page sees the same state of the account.
function dumpRows(
  tx: Tx,
  table: Owned,
  where: SQL | undefined,
  fields: [string, AnyColumn][],
  onRow: (row: Record<string, unknown>) => void,
  pageSize = PAGE,
): number {
  const select = Object.fromEntries(fields);
  let after = 0;
  let total = 0;
  for (;;) {
    const page = tx
      .select({ ...select, rowid: sql<number>`rowid` })
      .from(table)
      .where(and(where, gt(sql`rowid`, after)))
      .orderBy(asc(sql`rowid`))
      .limit(pageSize)
      .all() as Record<string, unknown>[];
    for (const row of page) {
      const out: Record<string, unknown> = {};
      for (const [name] of fields) out[name] = plain(row[name]);
      onRow(out);
    }
    total += page.length;
    if (page.length < pageSize) return total;
    after = page.at(-1)!.rowid as number;
  }
}

// Owner columns stay out as well: a restore takes the account from the session, never the file.
function archivedColumns(entry: BackupTable): [string, AnyColumn][] {
  return Object.values(getTableColumns(entry.table))
    .filter((column) => {
      const rule = entry.columns[column.name];
      if (!rule) throw new Error(`Sloupec ${entry.name}.${column.name} chybí v registru zálohy`);
      return rule !== "omit" && rule !== "owner";
    })
    .map((column) => [column.name, column]);
}

// A hard link keeps the blob as it was at the snapshot even if it is deleted while the archive is
// written; a copy stands in where the file system cannot link.
function keepBlob(ownerId: string, id: string, target: string): void {
  const source = blobPath(ownerId, id);
  try {
    linkSync(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new MissingBlob(id);
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw error;
    copyFileSync(source, target);
  }
}

type Watch = (bytes: number, cost: number) => void;

// The restore's memory guard over the backup as well (R-3): a backup that grows past it stops with
// the same answer as one over the limits.
function asTooLarge(guarded: () => void): void {
  try {
    guarded();
  } catch (error) {
    if (error instanceof RestoreRejected) throw new SnapshotTooLarge();
    throw error;
  }
}

function memoryWatch(guard: MemoryGuard): Watch {
  let lines = 0;
  let bytes = 0;
  return (size, cost) => {
    asTooLarge(() => guard.hold("line", cost));
    lines += 1;
    bytes += size;
    if (lines < MEMORY_LIMITS.everyLines && bytes < MEMORY_LIMITS.everyBytes) return;
    lines = 0;
    bytes = 0;
    asTooLarge(() => guard.check());
  };
}

// better-sqlite3 cannot hold a read transaction across an await, so everything the archive needs
// is written out here in one synchronous transaction; the event loop waits for its length.
export function snapshot(
  ownerId: string,
  dir: string,
  limits: RestoreLimits = RESTORE_LIMITS,
  guard: MemoryGuard = createMemoryGuard(),
): Snapshot {
  mkdirSync(join(dir, FILES_DIR), { recursive: true });
  const watch = memoryWatch(guard);
  const stats: LineStats = {
    longest: 0,
    nodes: 0,
    containers: 0,
    lineContainers: 0,
    lineDepth: 0,
  };
  return db.transaction((tx) => {
    const tables: Record<string, number> = {};
    const files: string[] = [];
    for (const entry of BACKUP_TABLES) {
      const table = entry.table as Owned;
      const lines = lineFile(join(dir, `${entry.name}.jsonl`), stats, watch, limits);
      const columns = archivedColumns(entry);
      // Written before the caps existed, or by a path that missed them: refused here rather than
      // by the restore (R-35).
      const jsonColumns = columns
        .filter(([, column]) => column.columnType === "SQLiteTextJson")
        .map(([name]) => name);
      const pageSize =
        jsonColumns.length > 0
          ? Math.max(4, Math.floor(PAGE_BYTES / rowBytesFor(entry.name, limits)))
          : PAGE;
      try {
        tables[entry.name] = dumpRows(
          tx,
          table,
          and(scoped(ownerId).where(table), entry.rows?.()),
          columns,
          (row) => {
            for (const name of jsonColumns) {
              if (jsonBytes(row[name]) > jsonBytesFor(entry.name, name, limits)) {
                throw new SnapshotTooLarge(blocking(entry.name, row));
              }
            }
            const bytes = lines.add(row);
            if (bytes > rowBytesFor(entry.name, limits)) {
              throw new SnapshotTooLarge(blocking(entry.name, row));
            }
            stats.longest = Math.max(stats.longest, Math.min(bytes, limits.maxRowBytes));
            if (entry.name === "file") files.push(row.id as string);
          },
          pageSize,
        );
      } finally {
        lines.close();
      }
    }
    for (const id of files) keepBlob(ownerId, id, join(dir, FILES_DIR, id));
    const rowsSoFar = Object.values(tables).reduce((sum, n) => sum + n, 0);
    const auditLines = lineFile(join(dir, AUDIT_FILE), stats, watch, limits, false);
    let audit = 0;
    try {
      // The history an earlier restore archived comes first, line for line as it was archived.
      const archived = tx
        .select({ id: file.id })
        .from(file)
        .where(scoped(ownerId).where(file, (t) => inArray(t.kind, FOLDED_FILES)))
        .orderBy(asc(file.createdAt), asc(file.id))
        .all();
      for (const { id } of archived) {
        let blob: Buffer;
        try {
          blob = readFileSync(blobPath(ownerId, id));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingBlob(id);
          throw error;
        }
        asTooLarge(() => guard.hold("audit", blob.length));
        // Walked by newline like the restore reads it: an archived audit never becomes one
        // string or one array, and the caps stop it as early as the restore would.
        for (let start = 0; start < blob.length;) {
          let end = blob.indexOf(0x0a, start);
          if (end < 0) end = blob.length;
          if (end - start > limits.maxLineBytes) throw new SnapshotTooLarge();
          if (end > start) {
            audit += 1;
            if (rowsSoFar + audit > limits.maxLines) throw new SnapshotTooLarge();
            auditLines.addLine(blob.toString("utf8", start, end));
          }
          start = end + 1;
        }
        guard.hold("audit", 0);
      }
      // Rows were redacted when written; only the account's own rows leave (R-31), and another
      // person's address and browser are masked as in the audit view.
      audit += dumpRows(
        tx,
        auditLog as unknown as Owned,
        scoped(ownerId).where(auditLog),
        Object.values(getTableColumns(auditLog)).map((column) => [column.name, column]),
        (row) => {
          const foreign = isForeignActor(row.actor_id as string | null, ownerId);
          auditLines.add(foreign ? { ...row, ip: null, user_agent: null } : row);
        },
      );
    } finally {
      auditLines.close();
    }
    const { nodes, containers, lineContainers, lineDepth } = stats;
    return {
      tables,
      files,
      audit,
      longestLine: stats.longest,
      nodes: { nodes, containers, lineContainers, lineDepth },
    };
  });
}
