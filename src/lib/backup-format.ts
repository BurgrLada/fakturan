import { z } from "zod";
import type { CalendarDate } from "./number-format";

export const BACKUP_FORMAT = "fakturan.account-backup";
// Raised together with a new tests/fixtures/backup/columns-v<n>.json and a BACKUP_UPGRADES step.
export const BACKUP_VERSION = 1;

export const MANIFEST_ENTRY = "manifest.json";
export const AUDIT_ENTRY = "audit.jsonl";

export function dataEntry(table: string): string {
  return `data/${table}.jsonl`;
}

export function fileEntry(id: string): string {
  return `files/${id}`;
}

export function backupFileName(day: CalendarDate): string {
  return `fakturan-zaloha-${day}.zip`;
}

// id gets a new UUID on restore, owner is taken from the session, ref:<table> points at an id of
// that table in the same archive, json-ids is text or JSON in which known ids are replaced, and
// omit never leaves the database (R-31, R-33).
export type ColumnRule = "id" | "owner" | "copy" | "json-ids" | "omit" | `ref:${string}`;

const PLAIN_RULES = new Set(["id", "owner", "copy", "json-ids", "omit"]);
const TABLE_NAME = /^[a-z][a-z_]{0,63}$/;

export function isColumnRule(value: string): value is ColumnRule {
  if (PLAIN_RULES.has(value)) return true;
  return value.startsWith("ref:") && TABLE_NAME.test(value.slice(4));
}

const ENTRY_NAME = /^(?:data\/[a-z][a-z_]{0,63}\.jsonl|files\/[A-Za-z0-9_-]{1,128}|audit\.jsonl)$/;
const MAX_ENTRIES = 1_000_000;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// The archive is foreign input even when Fakturan wrote it: the manifest is not a signature (R-30).
export const backupManifestSchema = z
  .strictObject({
    format: z.literal(BACKUP_FORMAT),
    v: z.number().int().min(1),
    app: z.string().min(1).max(64),
    migration: z.string().min(1).max(128),
    // SHA-256 of the column registry the archive was written with; same v, same registry.
    columns: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.iso.datetime(),
    counts: z.strictObject({
      tables: z.record(z.string().regex(TABLE_NAME), count),
      files: count,
      audit: count,
    }),
    entries: z.record(
      z.string().regex(ENTRY_NAME),
      z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: count }),
    ),
  })
  .refine((manifest) => Object.keys(manifest.entries).length <= MAX_ENTRIES);

export type BackupManifest = z.output<typeof backupManifestSchema>;

export type BackupRow = Record<string, unknown>;

// Steps from version n to n + 1, applied to each row of an older archive before it is validated.
// No version before 1 exists, so the list starts empty (R-31).
export const BACKUP_UPGRADES: Record<number, (table: string, row: BackupRow) => BackupRow> = {};

const MiB = 1024 * 1024;

// R-35: a backup has its own limits, far above those of a document import. A restore keeps no rows
// in memory: each row is checked, remapped in place and spooled to a file of its table, and the
// commit reads those files back. What grows with the archive is the id map and the bytes of the
// data entry being read (up to 200 MiB, off the heap). The bound on memory is the guard in
// src/server/backup/memory-guard.ts (640 MiB of growth, 60 % of the heap); the counts below are a
// cheap prefilter. Lines stay at 300 000 and data at 256 MiB because the commit is one
// synchronous transaction.
export const RESTORE_LIMITS = {
  archiveBytes: 1024 * MiB,
  // A compact manifest costs at most about 140 bytes per entry, so 28 000 entries fit in 4 MiB.
  manifestBytes: 4 * MiB,
  entries: 28_000,
  dataEntryBytes: 200 * MiB,
  // All data/* entries together, uncompressed; the audit and the files are not held as rows.
  dataTotalBytes: 256 * MiB,
  fileEntryBytes: 25 * MiB,
  maxLinesPerTable: 300_000,
  maxLines: 300_000,
  maxLineBytes: 2 * MiB,
  // Bytes do not bound the heap: three bytes of `{},` become a whole object. Counted on the bytes
  // before a line is parsed, so the budget holds whatever keys the shapes let through (C-1). A
  // legitimate account of 300 000 rows has about 19.3 M nodes and 0.59 M objects (N-2).
  maxLineContainers: 20_000,
  maxLineDepth: 40,
  maxContainers: 1_000_000,
  maxNodes: 25_000_000,
};

export type RestoreLimits = typeof RESTORE_LIMITS;

export type JsonShape = { containers: number; nodes: number; depth: number };

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

// Objects and arrays, and keys plus values (commas, colons and containers), outside strings. The
// same count runs over the bytes of a restored line and over the text a backup writes.
function shape(length: number, at: (index: number) => number): JsonShape {
  const result: JsonShape = { containers: 0, nodes: 0, depth: 0 };
  let depth = 0;
  let inString = false;
  for (let i = 0; i < length; i++) {
    const code = at(i);
    if (inString) {
      if (code === BACKSLASH) i += 1;
      else if (code === QUOTE) inString = false;
      continue;
    }
    if (code === QUOTE) inString = true;
    else if (code === 0x7b || code === 0x5b) {
      depth += 1;
      result.containers += 1;
      result.nodes += 1;
      if (depth > result.depth) result.depth = depth;
    } else if (code === 0x7d || code === 0x5d) depth -= 1;
    else if (code === 0x2c || code === 0x3a) result.nodes += 1;
  }
  return result;
}

export function jsonNodes(text: string): JsonShape {
  return shape(text.length, (index) => text.charCodeAt(index));
}

export function jsonNodesOfBytes(bytes: Uint8Array, start: number, end: number): JsonShape {
  return shape(end - start, (index) => bytes[start + index]!);
}
