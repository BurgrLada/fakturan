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
  type RestoreLimits,
} from "@/lib/backup-format";
import { CURRENCIES } from "@/lib/currency";
import { INVOICE_TYPES } from "@/lib/invoice";
import { isCalendarDate } from "@/lib/number-format";
import { LOGO_POSITIONS } from "@/lib/preferences";
import { InputRejected } from "@/lib/safe-input/limits";
import { readZipEntries } from "@/lib/safe-input/zip";
import { TEXTS } from "@/lib/texts";
import { PAYMENT_MEANS_CODES } from "../isdoc/parse";
import {
  BACKUP_TABLES,
  backupColumnsHash,
  FOLDED_FILES,
  TEMPORARY_FILES,
  type BackupTable,
} from "./tables";

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

const text = z.string().max(MAX_TEXT);
const date = z.string().refine(isCalendarDate);
const strings = z.array(text).max(10_000);
const appearance = z.looseObject({
  designId: text,
  colors: z.looseObject({ accent: text, surface: text, text, line: text }),
  logoPosition: z.enum(LOGO_POSITIONS),
  showLogo: z.boolean(),
  showQr: z.boolean(),
  showQrLogo: z.boolean(),
  showSignature: z.boolean(),
  showDuzp: z.boolean(),
});
const party = {
  name: text,
  street: text,
  city: text,
  zip: text,
  country: text,
  ico: text,
  dic: text,
};
const supplierSnapshot = z.looseObject({
  ...party,
  email: text,
  phone: text,
  web: text,
  registryNote: text,
  contactPerson: text,
  vatIdentified: z.boolean(),
  footerText: text,
  notVatPayerCs: text,
  notVatPayerEn: text,
});
const customerSnapshot = z.looseObject({ ...party, email: text, phone: text });
const accountSnapshot = z.looseObject({
  name: text,
  currency: z.enum(CURRENCIES),
  number: text,
  bankCode: text,
  iban: text,
  swift: text,
});
const relatedSnapshot = z.looseObject({
  type: z.enum(INVOICE_TYPES),
  number: text,
  issueDate: date,
});

// JSON and dates that pages, PDF and sending read without a second check; the remaining JSON only
// has to be shallow.
const KNOWN_SHAPES: Record<string, z.ZodType> = {
  "invoice.appearance": appearance,
  "invoice.supplier_snapshot": supplierSnapshot,
  "invoice.customer_snapshot": customerSnapshot,
  "invoice.account_snapshot": accountSnapshot,
  "invoice.related_snapshot": relatedSnapshot,
  "invoice.issue_date": date,
  "invoice.due_date": date,
  "invoice.taxable_date": date,
  "invoice.exchange_rate_date": date,
  "invoice.period_from": date,
  "invoice.period_to": date,
  "invoice.reminders_snooze_until": date,
  "payment.paid_on": date,
  "bank_notification.paid_on": date,
  "recurring_invoice.starts_on": date,
  "recurring_invoice.ends_on": date,
  "recurring_invoice.cursor_date": date,
  "recurring_run.planned_date": date,
  "recurring_run.period_from": date,
  "recurring_run.period_to": date,
  "preferences.fixed_rates": z.partialRecord(z.enum(CURRENCIES), z.number().int().positive()),
  "customer.extra_emails": strings,
  "catalog_item.tags": strings,
  "email_log.to": strings,
  "email_log.cc": strings,
  "email_log.bcc": strings,
  "mail_settings.cc": strings,
  "mail_settings.bcc": strings,
};

// What a column may hold, derived from the schema: the archive is never trusted to name a type.
function columnSchema(entry: BackupTable, column: AnyColumn): z.ZodType | null {
  const rule = entry.columns[column.name];
  if (!rule || rule === "omit") return null;
  if (rule === "owner") return z.string().max(128).optional();
  let schema: z.ZodType;
  const shape = KNOWN_SHAPES[`${entry.name}.${column.name}`];
  if (rule === "id" || rule.startsWith("ref:")) schema = ID;
  else if (entry.name === "invoice" && column.name === "import_payment_code") {
    schema = z.string().refine((code) => PAYMENT_MEANS_CODES.has(code));
  } else if (shape) schema = shape;
  else if (column.columnType === "SQLiteTextJson") schema = json;
  else if (column.columnType === "SQLiteBoolean") schema = z.boolean();
  else if (column.columnType === "SQLiteTimestamp") {
    schema = z.number().int().min(0).max(8_640_000_000_000_000);
  } else if (column.columnType === "SQLiteInteger") schema = z.number().int().safe();
  else {
    const values = (column as AnyColumn & { enumValues?: string[] }).enumValues;
    schema = values?.length ? z.enum(values as [string, ...string[]]) : text;
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
    schema = schema.refine(
      (row) => ![...TEMPORARY_FILES, ...FOLDED_FILES].includes(row.kind as never),
    );
  }
  rowSchemas.set(entry.name, schema);
  return schema;
}

type LineBudget = { limits: RestoreLimits; total: number };

// Walks the entry by newline and decodes one line at a time: an entry of millions of tiny lines
// never becomes one string or one array (C-1). `take` sees each line as it is found and may stop.
function eachLine(
  bytes: Uint8Array,
  budget: LineBudget,
  cap: number,
  onError: () => RestoreRejected,
  take: (value: unknown) => void,
): number {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  let count = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    if (end > start) {
      if (end - start > budget.limits.maxLineBytes) throw onError();
      count += 1;
      budget.total += 1;
      if (count > cap || budget.total > budget.limits.maxLines) {
        throw new RestoreRejected(E.tooManyLines);
      }
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(bytes.subarray(start, end)));
      } catch {
        throw onError();
      }
      take(value);
    }
    start = end + 1;
  }
  return count;
}

function upgrade(table: string, row: unknown, v: number): unknown {
  let current = row as ArchiveRow;
  for (let step = v; step < BACKUP_VERSION; step++)
    current = BACKUP_UPGRADES[step]!(table, current);
  return current;
}

function validRows(
  entry: BackupTable,
  bytes: Uint8Array,
  manifest: BackupManifest,
  budget: LineBudget,
): ArchiveRow[] {
  const schema = rowSchema(entry);
  const rows: ArchiveRow[] = [];
  const expected = manifest.counts.tables[entry.name] ?? 0;
  const invalid = () => new RestoreRejected(E.row(entry.name));
  eachLine(bytes, budget, budget.limits.maxLinesPerTable, invalid, (line) => {
    if (rows.length >= expected) throw new RestoreRejected(E.counts);
    let upgraded: unknown;
    try {
      upgraded = upgrade(entry.name, line, manifest.v);
    } catch {
      throw invalid();
    }
    const parsed = schema.safeParse(upgraded);
    if (!parsed.success) throw invalid();
    rows.push(parsed.data);
  });
  return rows;
}

const auditLine = z.custom<object>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
);

// The audit is only archived as a file, so its lines are counted and must be JSON objects.
function auditLines(bytes: Uint8Array, manifest: BackupManifest, budget: LineBudget): number {
  const invalid = () => new RestoreRejected(E.audit);
  return eachLine(bytes, budget, manifest.counts.audit, invalid, (line) => {
    if (!auditLine.safeParse(line).success) throw invalid();
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

export function entryLimit(name: string, limits: RestoreLimits = RESTORE_LIMITS): number {
  if (name === MANIFEST_ENTRY) return limits.manifestBytes;
  if (name.startsWith("files/")) return limits.fileEntryBytes;
  return limits.dataEntryBytes;
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
  limits: RestoreLimits = RESTORE_LIMITS,
): Promise<ArchiveSummary> {
  const budget: LineBudget = { limits, total: 0 };
  const archiveHash = createHash("sha256");
  const byName = new Map(BACKUP_TABLES.map((entry) => [`data/${entry.name}.jsonl`, entry]));
  const seen = new Set<string>();
  const counted: Record<string, number> = {};
  const files: string[] = [];
  let manifest: BackupManifest | null = null;
  let auditCount = 0;
  let fileRows: string[] = [];
  let rejection: unknown = null;

  try {
    await readZipEntries(
      hashed(path, archiveHash),
      {
        maxEntries: limits.entries,
        maxEntryBytes: limits.dataEntryBytes,
        maxPdfEntryBytes: limits.fileEntryBytes,
        maxTotalBytes: limits.archiveBytes,
        maxRatio: 200,
        ratioGraceBytes: 1024 * KiB,
        chunkBytes: 16 * KiB,
        maxBytesFor: (name) => entryLimit(name, limits),
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
      const rows = validRows(table, bytes, manifest, budget);
      counted[table.name] = rows.length;
      if (table.name === "file") fileRows = rows.map((row) => row.id as string);
      await handlers.rows?.(table, rows);
    } else if (name.startsWith("files/")) {
      files.push(name.slice("files/".length));
      await handlers.file?.(name.slice("files/".length), bytes);
    } else if (name === AUDIT_ENTRY) {
      auditCount = auditLines(bytes, manifest, budget);
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
    found.counts.audit !== auditCount ||
    !seen.has(AUDIT_ENTRY);
  const rowIds = new Set(fileRows);
  const blobsDiffer = rowIds.size !== files.length || files.some((id) => !rowIds.has(id));
  if (missing || tablesMissing || countsDiffer || blobsDiffer) throw new RestoreRejected(E.counts);
  return { manifest: found, sha256: archiveHash.digest("hex"), files };
}
