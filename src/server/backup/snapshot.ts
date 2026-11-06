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
import { db, type Tx } from "../db";
import { auditLog, file } from "../db/schema";
import { scoped } from "../db/scoped";
import { blobPath } from "../files/store";
import { isForeignActor } from "../services/audit-read";
import { BACKUP_TABLES, FOLDED_FILES, type BackupTable } from "./tables";

const PAGE = 500;
const LINE_BUFFER = 64 * 1024;
export const AUDIT_FILE = "audit.jsonl";
export const FILES_DIR = "files";

// A file row of the account without its blob: the archive would silently miss it.
export class MissingBlob extends Error {}

type Owned = SQLiteTable & { userId: AnyColumn };

export type Snapshot = {
  tables: Record<string, number>;
  files: string[];
  audit: number;
  longestLine: number;
};

type Lines = {
  add(row: Record<string, unknown>): void;
  addLine(line: string): void;
  close(): void;
};

function lineFile(path: string, stats: { longest: number }): Lines {
  const fd = openSync(path, "wx");
  let pending = "";
  const flush = () => {
    if (pending) writeSync(fd, pending);
    pending = "";
  };
  const addLine = (line: string) => {
    stats.longest = Math.max(stats.longest, Buffer.byteLength(line));
    pending += `${line}\n`;
    if (pending.length >= LINE_BUFFER) flush();
  };
  return {
    add(row) {
      addLine(JSON.stringify(row));
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
      .limit(PAGE)
      .all() as Record<string, unknown>[];
    for (const row of page) {
      const out: Record<string, unknown> = {};
      for (const [name] of fields) out[name] = plain(row[name]);
      onRow(out);
    }
    total += page.length;
    if (page.length < PAGE) return total;
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

// better-sqlite3 cannot hold a read transaction across an await, so everything the archive needs
// is written out here in one synchronous transaction; the event loop waits for its length.
export function snapshot(ownerId: string, dir: string): Snapshot {
  mkdirSync(join(dir, FILES_DIR), { recursive: true });
  const stats = { longest: 0 };
  return db.transaction((tx) => {
    const tables: Record<string, number> = {};
    const files: string[] = [];
    for (const entry of BACKUP_TABLES) {
      const table = entry.table as Owned;
      const lines = lineFile(join(dir, `${entry.name}.jsonl`), stats);
      try {
        tables[entry.name] = dumpRows(
          tx,
          table,
          and(scoped(ownerId).where(table), entry.rows?.()),
          archivedColumns(entry),
          (row) => {
            lines.add(row);
            if (entry.name === "file") files.push(row.id as string);
          },
        );
      } finally {
        lines.close();
      }
    }
    for (const id of files) keepBlob(ownerId, id, join(dir, FILES_DIR, id));
    const auditLines = lineFile(join(dir, AUDIT_FILE), stats);
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
        let text: string;
        try {
          text = readFileSync(blobPath(ownerId, id), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingBlob(id);
          throw error;
        }
        for (const line of text.split("\n")) {
          if (!line) continue;
          auditLines.addLine(line);
          audit += 1;
        }
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
    return { tables, files, audit, longestLine: stats.longest };
  });
}
