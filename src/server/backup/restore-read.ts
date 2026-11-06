import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { getTableColumns, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import {
  AUDIT_ENTRY,
  BACKUP_UPGRADES,
  BACKUP_VERSION,
  backupManifestSchema,
  MANIFEST_ENTRY,
  RESTORE_LIMITS,
  type BackupManifest,
} from "@/lib/backup-format";
import { InputRejected } from "@/lib/safe-input/limits";
import { readZipEntries } from "@/lib/safe-input/zip";
import { TEXTS } from "@/lib/texts";
import { PAYMENT_MEANS_CODES } from "../isdoc/parse";
import { BACKUP_TABLES, backupColumnsHash, TEMPORARY_FILES, type BackupTable } from "./tables";

const E = TEXTS.restore.errors;
const KiB = 1024;

// The message is shown to the person; it names at most a table of the registry, never a value or
// an entry name from the archive.
export class RestoreRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRejected";
  }
}

export type ArchiveRow = Record<string, unknown>;

export type ArchiveHandlers = {
  rows?: (entry: BackupTable, rows: ArchiveRow[]) => void | Promise<void>;
  file?: (id: string, bytes: Uint8Array) => void | Promise<void>;
  audit?: (bytes: Uint8Array) => void | Promise<void>;
};

export type ArchiveSummary = { manifest: BackupManifest; sha256: string; files: string[] };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const MAX_TEXT = 1_000_000;
const MAX_JSON_DEPTH = 32;

function shallowEnough(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => shallowEnough(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value).every((item) => shallowEnough(item, depth + 1));
  }
  return true;
}

const json = z.custom<unknown>((value) => value !== undefined && shallowEnough(value));

// What a column may hold, derived from the schema: the archive is never trusted to name a type.
function columnSchema(entry: BackupTable, column: AnyColumn): z.ZodType | null {
  const rule = entry.columns[column.name];
  if (!rule || rule === "omit") return null;
  if (rule === "owner") return z.string().max(128).optional();
  let schema: z.ZodType;
  if (rule === "id" || rule.startsWith("ref:")) schema = ID;
  else if (entry.name === "invoice" && column.name === "import_payment_code") {
    schema = z.string().refine((code) => PAYMENT_MEANS_CODES.has(code));
  } else if (column.columnType === "SQLiteTextJson") schema = json;
  else if (column.columnType === "SQLiteBoolean") schema = z.boolean();
  else if (column.columnType === "SQLiteTimestamp") {
    schema = z.number().int().min(0).max(8_640_000_000_000_000);
  } else if (column.columnType === "SQLiteInteger") schema = z.number().int().safe();
  else {
    const values = (column as AnyColumn & { enumValues?: string[] }).enumValues;
    schema = values?.length ? z.enum(values as [string, ...string[]]) : z.string().max(MAX_TEXT);
  }
  return column.notNull ? schema : schema.nullable();
}

const rowSchemas = new Map<string, z.ZodType<ArchiveRow>>();

function rowSchema(entry: BackupTable): z.ZodType<ArchiveRow> {
  const cached = rowSchemas.get(entry.name);
  if (cached) return cached;
  const shape: Record<string, z.ZodType> = {};
  for (const column of Object.values(getTableColumns(entry.table))) {
    const schema = columnSchema(entry, column);
    if (schema) shape[column.name] = schema;
  }
  let schema: z.ZodType<ArchiveRow> = z.strictObject(shape) as z.ZodType<ArchiveRow>;
  if (entry.name === "file") {
    // A temporary upload or an export never goes into a backup, so one here is planted.
    schema = schema.refine((row) => !TEMPORARY_FILES.includes(row.kind as never));
  }
  rowSchemas.set(entry.name, schema);
  return schema;
}

function parseLines(bytes: Uint8Array): unknown[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function upgrade(table: string, rows: unknown[], v: number): unknown[] {
  let current = rows as ArchiveRow[];
  for (let step = v; step < BACKUP_VERSION; step++)
    current = BACKUP_UPGRADES[step]!(table, current);
  return current;
}

function validRows(entry: BackupTable, bytes: Uint8Array, v: number): ArchiveRow[] {
  let lines: unknown[];
  try {
    lines = upgrade(entry.name, parseLines(bytes), v);
  } catch {
    throw new RestoreRejected(E.row(entry.name));
  }
  const schema = rowSchema(entry);
  return lines.map((line) => {
    const parsed = schema.safeParse(line);
    if (!parsed.success) throw new RestoreRejected(E.row(entry.name));
    return parsed.data;
  });
}

function checkManifest(bytes: Uint8Array): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RestoreRejected(E.manifest);
  }
  const version = z.object({ v: z.number().int() }).safeParse(parsed);
  if (version.success && version.data.v > BACKUP_VERSION) throw new RestoreRejected(E.version);
  const manifest = backupManifestSchema.safeParse(parsed);
  if (!manifest.success) throw new RestoreRejected(E.manifest);
  const { v, columns } = manifest.data;
  for (let step = v; step < BACKUP_VERSION; step++) {
    if (!BACKUP_UPGRADES[step]) throw new RestoreRejected(E.version);
  }
  if (v === BACKUP_VERSION && columns !== backupColumnsHash()) {
    throw new RestoreRejected(E.version);
  }
  return manifest.data;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function entryLimit(name: string): number {
  if (name === MANIFEST_ENTRY) return RESTORE_LIMITS.manifestBytes;
  if (name.startsWith("files/")) return RESTORE_LIMITS.fileEntryBytes;
  return RESTORE_LIMITS.dataEntryBytes;
}

async function* hashed(path: string, hash: ReturnType<typeof createHash>) {
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * KiB })) {
    hash.update(chunk as Buffer);
    yield chunk as Uint8Array;
  }
}

// One full pass over the archive: every limit, the manifest first, then each entry against its
// hash and each row against the registry. Called twice by a restore; the handlers decide what a
// pass keeps (R-32).
export async function scanArchive(
  path: string,
  handlers: ArchiveHandlers,
): Promise<ArchiveSummary> {
  const archiveHash = createHash("sha256");
  const byName = new Map(BACKUP_TABLES.map((entry) => [`data/${entry.name}.jsonl`, entry]));
  const seen = new Set<string>();
  const counted: Record<string, number> = {};
  const files: string[] = [];
  let manifest: BackupManifest | null = null;
  let auditLines = 0;
  let fileRows: string[] = [];
  let rejection: unknown = null;

  try {
    await readZipEntries(
      hashed(path, archiveHash),
      {
        maxEntries: RESTORE_LIMITS.entries,
        maxEntryBytes: RESTORE_LIMITS.dataEntryBytes,
        maxPdfEntryBytes: RESTORE_LIMITS.fileEntryBytes,
        maxTotalBytes: RESTORE_LIMITS.archiveBytes,
        maxRatio: 200,
        ratioGraceBytes: 1024 * KiB,
        chunkBytes: 16 * KiB,
        maxBytesFor: entryLimit,
      },
      async ({ name, bytes }) => {
        try {
          await onEntry(name, bytes);
        } catch (error) {
          // readZipEntries reports anything thrown here as a corrupt archive; keep the real cause.
          rejection = error;
          throw error;
        }
      },
    );
  } catch (error) {
    if (rejection) throw rejection;
    if (error instanceof InputRejected) throw new RestoreRejected(E.archive);
    throw error;
  }

  async function onEntry(name: string, bytes: Uint8Array): Promise<void> {
    if (!manifest) {
      if (name !== MANIFEST_ENTRY) throw new RestoreRejected(E.manifest);
      manifest = checkManifest(bytes);
      return;
    }
    if (seen.has(name) || name === MANIFEST_ENTRY) throw new RestoreRejected(E.duplicate);
    seen.add(name);
    const expected = Object.hasOwn(manifest.entries, name) ? manifest.entries[name] : undefined;
    if (!expected) throw new RestoreRejected(E.entry);
    if (expected.size !== bytes.length || expected.sha256 !== sha256(bytes)) {
      throw new RestoreRejected(E.hash);
    }
    const table = byName.get(name);
    if (table) {
      const rows = validRows(table, bytes, manifest.v);
      counted[table.name] = rows.length;
      if (table.name === "file") fileRows = rows.map((row) => row.id as string);
      await handlers.rows?.(table, rows);
    } else if (name.startsWith("files/")) {
      files.push(name.slice("files/".length));
      await handlers.file?.(name.slice("files/".length), bytes);
    } else if (name === AUDIT_ENTRY) {
      auditLines = parseLines(bytes).length;
      await handlers.audit?.(bytes);
    } else {
      throw new RestoreRejected(E.entry);
    }
  }

  const found = manifest as BackupManifest | null;
  if (!found) throw new RestoreRejected(E.manifest);
  const missing = Object.keys(found.entries).some((name) => !seen.has(name));
  const tablesMissing = BACKUP_TABLES.some((entry) => !(entry.name in counted));
  const countsDiffer =
    BACKUP_TABLES.some((entry) => found.counts.tables[entry.name] !== counted[entry.name]) ||
    Object.keys(found.counts.tables).length !== BACKUP_TABLES.length ||
    found.counts.files !== files.length ||
    found.counts.audit !== auditLines ||
    !seen.has(AUDIT_ENTRY);
  const rowIds = new Set(fileRows);
  const blobsDiffer = rowIds.size !== files.length || files.some((id) => !rowIds.has(id));
  if (missing || tablesMissing || countsDiffer || blobsDiffer) throw new RestoreRejected(E.counts);
  return { manifest: found, sha256: archiveHash.digest("hex"), files };
}
