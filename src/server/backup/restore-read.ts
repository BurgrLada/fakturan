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
  FILES_INDEX_ENTRY,
  fileIndexLineSchema,
  jsonBytes,
  jsonBytesFor,
  jsonNodesOfBytes,
  rowBytesFor,
  MANIFEST_ENTRY,
  RESTORE_LIMITS,
  type BackupManifest,
  type RestoreLimits,
} from "@/lib/backup-format";
import { CURRENCIES } from "@/lib/currency";
import { INVOICE_STATUSES, INVOICE_TYPES, MAX_DOCUMENT_LINES } from "@/lib/invoice";
import { DISCOUNT_KINDS, ROUNDING_MODES } from "@/lib/invoice-totals";
import { isCalendarDate } from "@/lib/number-format";
import { DATE_FORMATS, LANGUAGES, LOGO_POSITIONS, PAYMENT_METHODS } from "@/lib/preferences";
import { accountRowLimit, PER_PARENT_LIMITS } from "@/lib/account-limits";
import { textLimit } from "@/lib/text-limits";
import { MAX_BODY_CHARS, MAX_SUBJECT_CHARS } from "@/lib/email-template";
import {
  DATE_FORMATS as IMPORT_DATE_FORMATS,
  DECIMAL_SEPARATORS,
  MAPPING_TARGETS,
} from "@/lib/import-mapping";
import { widgetConfigSchema } from "@/lib/widget-config";
import { InputRejected } from "@/lib/safe-input/limits";
import { readZipEntries } from "@/lib/safe-input/zip";
import { TEXTS } from "@/lib/texts";
import { PAYMENT_MEANS_CODES } from "../isdoc/parse";
import {
  createMemoryGuard,
  HELD_COSTS,
  lineCost,
  MEMORY_LIMITS,
  RestoreRejected,
  type MemoryGuard,
} from "./memory-guard";
import {
  BACKUP_TABLES,
  backupColumnsHash,
  FOLDED_FILES,
  TEMPORARY_FILES,
  type BackupTable,
} from "./tables";

const E = TEXTS.restore.errors;
const KiB = 1024;

export { RestoreRejected };

export type ArchiveRow = Record<string, unknown>;

// `row` sees each checked row as it is read and must not keep it; `tableDone` follows the last row
// of a table and may wait.
export type ArchiveHandlers = {
  row?: (entry: BackupTable, row: ArchiveRow) => void;
  tableDone?: (entry: BackupTable, count: number) => void | Promise<void>;
  file?: (id: string, bytes: Uint8Array) => void | Promise<void>;
  audit?: (bytes: Uint8Array) => void | Promise<void>;
};

export type ArchiveSummary = { manifest: BackupManifest; sha256: string; files: string[] };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const MAX_TEXT = 1_000_000;

const text = z.string().max(MAX_TEXT);
const date = z.string().refine(isCalendarDate);
const strings = z.array(text).max(10_000);
// Stored JSON is read whole by pages, PDF and sending, so its shape is strict: an extra key would be
// room for any amount of data the app never wrote (C-2 of plan 9). Mirrors the types in
// src/lib/invoice-document.ts, src/lib/invoice-template.ts and Appearance in src/lib/invoice.ts.
const appearance = z.strictObject({
  designId: text,
  colors: z.strictObject({ accent: text, surface: text, text, line: text }),
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
const supplierSnapshot = z.strictObject({
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
  // Absent on snapshots frozen before advance invoices.
  advanceNoteCs: text.optional(),
  advanceNoteEn: text.optional(),
});
const customerSnapshot = z.strictObject({ ...party, email: text, phone: text });
const accountSnapshot = z.strictObject({
  name: text,
  currency: z.enum(CURRENCIES),
  number: text,
  bankCode: text,
  iban: text,
  swift: text,
});
const relatedSnapshot = z.strictObject({
  type: z.enum(INVOICE_TYPES),
  number: text,
  issueDate: date,
});

const integer = z.number().int().safe();
const nullableId = z.string().max(128).nullable();
const templateLine = z.strictObject({
  catalogItemId: nullableId,
  name: text,
  description: text,
  quantityMilli: integer,
  unit: text,
  unitPriceMinor: integer,
  discountKind: z.enum(DISCOUNT_KINDS),
  discountValue: integer,
});
const templateDocument = z.strictObject({
  type: z.enum(INVOICE_TYPES),
  bankAccountId: nullableId,
  dueDays: integer,
  language: z.enum(LANGUAGES),
  currency: z.enum(CURRENCIES),
  paymentMethod: z.enum(PAYMENT_METHODS),
  orderRef: text,
  reference: text,
  textBefore: text,
  textAfter: text,
  note: text,
  discountKind: z.enum(DISCOUNT_KINDS),
  discountValue: integer,
  rounding: z.enum(ROUNDING_MODES),
  appearance,
  // Templates and plans stored before foreign invoices have neither.
  foreign: z.boolean().optional(),
  clause: text.optional(),
  lines: z.array(templateLine).max(MAX_DOCUMENT_LINES),
});
// Versions were frozen by every release since issuing began and fields were added along the way,
// so each known key may be missing; no other key may be present.
const nullableDate = date.nullable();
const invoiceDocument = z
  .strictObject({
    id: nullableId,
    type: z.enum(INVOICE_TYPES),
    status: z.enum(INVOICE_STATUSES),
    number: text.nullable(),
    variableSymbol: text.nullable(),
    variableSymbolManual: z.boolean(),
    seriesId: nullableId,
    customerId: nullableId,
    customerName: text,
    bankAccountId: nullableId,
    issueDate: nullableDate,
    dueDate: nullableDate,
    taxableDate: nullableDate,
    language: z.enum(LANGUAGES),
    currency: z.enum(CURRENCIES),
    exchangeRateMicros: integer.nullable(),
    foreign: z.boolean(),
    clause: text,
    paymentMethod: z.enum(PAYMENT_METHODS),
    orderRef: text,
    reference: text,
    textBefore: text,
    textAfter: text,
    note: text,
    discountKind: z.enum(DISCOUNT_KINDS),
    discountValue: integer,
    rounding: z.enum(ROUNDING_MODES),
    dateFormat: z.enum(DATE_FORMATS).nullable(),
    periodFrom: nullableDate,
    periodTo: nullableDate,
    appearance,
    lines: z.array(templateLine.extend({ netMinor: integer }).partial()).max(MAX_DOCUMENT_LINES),
    snapshot: z
      .strictObject({
        supplier: supplierSnapshot.nullable(),
        customer: customerSnapshot.nullable(),
        account: accountSnapshot.nullable(),
      })
      .partial(),
    images: z
      .strictObject({
        logoFileId: nullableId,
        qrLogoFileId: nullableId,
        signatureFileId: nullableId,
      })
      .partial(),
    totals: z
      .strictObject({
        subtotalMinor: integer,
        discountMinor: integer,
        roundingMinor: integer,
        totalMinor: integer,
        paidMinor: integer,
        creditsMinor: integer,
        advanceMinor: integer,
        supersededAt: z.union([text, integer]).nullable(),
      })
      .partial(),
    relatedDocument: relatedSnapshot.nullable(),
    paymentUnknown: z.literal(true),
    sourcePaymentCode: text,
  })
  .partial();

// JSON and dates that pages, PDF and sending read without a second check; the remaining JSON only
// has to be shallow.
// The remaining JSON columns, each as the app writes it: reminder texts, an import mapping, the
// counts of a finished import, a receipt print, the params of a notice and a widget.
const mailContent = z.strictObject({
  subject: z.string().max(MAX_SUBJECT_CHARS),
  body: z.string().max(MAX_BODY_CHARS),
});
const reminderTexts = z.strictObject({ cs: mailContent.optional(), en: mailContent.optional() });
const MAX_RECORD_KEYS = 64;
const fewKeys = (value: object) => Object.keys(value).length <= MAX_RECORD_KEYS;
const importMapping = z.strictObject({
  target: z.enum(MAPPING_TARGETS),
  columns: z.record(z.string().max(40), z.string().max(200)).refine(fewKeys),
  dateFormat: z.enum(IMPORT_DATE_FORMATS),
  decimal: z.enum(DECIMAL_SEPARATORS),
  currency: z.enum(CURRENCIES),
  source: z.string().max(200),
});
const importSummary = z.record(z.string().max(40), integer).refine(fewKeys);
const receiptPrint = z.strictObject({ creditedMinor: integer, paidOn: date, dueMinor: integer });
const notificationParams = z
  .record(z.string().max(64), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]))
  .refine(fewKeys);

const KNOWN_SHAPES: Record<string, z.ZodType> = {
  "reminder_rule.texts": reminderTexts,
  "mapping_preset.mapping": importMapping,
  "import_batch.mapping": importMapping,
  "import_batch.summary": importSummary,
  "email_log.receipt_print": receiptPrint,
  "notification.params": notificationParams,
  // Checked, not parsed into: the schema fills defaults, and the restored row stays as archived.
  "dashboard_widget.config": z.custom<unknown>(
    (value) => widgetConfigSchema.safeParse(value).success,
  ),
  "invoice.appearance": appearance,
  "invoice.supplier_snapshot": supplierSnapshot,
  "invoice.customer_snapshot": customerSnapshot,
  "invoice.account_snapshot": accountSnapshot,
  "invoice.related_snapshot": relatedSnapshot,
  "invoice_template.document": templateDocument,
  "recurring_invoice.document": templateDocument,
  "invoice_version.document": invoiceDocument,
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
  else if (column.columnType === "SQLiteTextJson") {
    // Every JSON column has a shape (backup-registry test); a new one fails here, not silently.
    throw new Error(`Sloupec ${entry.name}.${column.name} nemá tvar pro obnovu`);
  } else if (column.columnType === "SQLiteBoolean") schema = z.boolean();
  else if (column.columnType === "SQLiteTimestamp") {
    schema = z.number().int().min(0).max(8_640_000_000_000_000);
  } else if (column.columnType === "SQLiteInteger") schema = z.number().int().safe();
  else {
    const values = (column as AnyColumn & { enumValues?: string[] }).enumValues;
    schema = values?.length ? z.enum(values as [string, ...string[]]) : text;
  }
  // The app reads a JSON column whole wherever it reads it, so its size is capped on its own, as the
  // app caps what it writes (STORED_JSON_BYTES).
  if (column.columnType === "SQLiteTextJson") {
    const cap = jsonBytesFor(entry.name, column.name, RESTORE_LIMITS);
    schema = schema.refine((value) => jsonBytes(value) <= cap);
  }
  // No longer than the app itself writes (TEXT_LIMITS); ids and refs have their own pattern.
  const limit = textLimit(entry.name, column.name);
  if (limit !== undefined && rule !== "id" && !rule.startsWith("ref:")) {
    schema = schema.refine((value) => typeof value !== "string" || value.length <= limit);
  }
  return column.notNull ? schema : schema.nullable();
}

const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
// The type a file is served with comes from what the app itself stores for that kind, never from
// an archive's say-so (m-8).
const MIMES_BY_KIND: Record<string, readonly string[]> = {
  logo: IMAGES,
  qr_logo: IMAGES,
  signature: IMAGES,
  sent_pdf: ["application/pdf"],
  import_pdf: ["application/pdf"],
  sent_isdoc: ["application/xml"],
};

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
      (row) =>
        ![...TEMPORARY_FILES, ...FOLDED_FILES].includes(row.kind as never) &&
        (MIMES_BY_KIND[row.kind as string] ?? []).includes(row.mime_type as string),
    );
  }
  rowSchemas.set(entry.name, schema);
  return schema;
}

type LineBudget = {
  limits: RestoreLimits;
  total: number;
  containers: number;
  nodes: number;
  guard: MemoryGuard;
  linesSinceCheck: number;
  bytesSinceCheck: number;
};

function watchMemory(budget: LineBudget, bytes: number): void {
  budget.linesSinceCheck += 1;
  budget.bytesSinceCheck += bytes;
  if (
    budget.linesSinceCheck >= MEMORY_LIMITS.everyLines ||
    budget.bytesSinceCheck >= MEMORY_LIMITS.everyBytes
  ) {
    budget.linesSinceCheck = 0;
    budget.bytesSinceCheck = 0;
    budget.guard.check();
  }
}

// Rows count for the archive's nodes and lines, the audit for its lines only, and files.jsonl for
// neither: it has its own cap, the entry count.
type LineKind = "rows" | "audit" | "index";

// Walks the entry by newline and decodes one line at a time: an entry of millions of tiny lines
// never becomes one string or one array (C-1). `take` sees each line as it is found and may stop;
// nothing holds the line after it returns.
function eachLine(
  bytes: Uint8Array,
  budget: LineBudget,
  cap: number,
  onError: () => RestoreRejected,
  take: (value: unknown) => void,
  kind: LineKind = "rows",
  rowBytes = budget.limits.maxRowBytes,
): number {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  let count = 0;
  while (start < bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    // The writer never leaves a blank line; skipping them would let a few bytes of upload carry
    // hundreds of MiB of newlines into the next backup.
    const maxBytes = kind === "rows" ? rowBytes : budget.limits.maxLineBytes;
    if (end === start || end - start > maxBytes) throw onError();
    const shape = jsonNodesOfBytes(bytes, start, end);
    const { containers, nodes, depth } = shape;
    if (containers > budget.limits.maxLineContainers || depth > budget.limits.maxLineDepth) {
      throw onError();
    }
    // A cheap prefilter on the bytes before the parser runs (R-4); the memory guard is the bound.
    // The audit is only read through and counts per line alone.
    if (kind === "rows") {
      budget.containers += containers;
      budget.nodes += nodes;
      if (
        budget.containers > budget.limits.maxContainers ||
        budget.nodes > budget.limits.maxNodes
      ) {
        throw new RestoreRejected(E.tooManyNodes);
      }
    }
    count += 1;
    if (kind !== "index") budget.total += 1;
    if (count > cap || budget.total > budget.limits.maxLines) {
      throw new RestoreRejected(kind === "index" ? E.filesIndex : E.tooManyLines);
    }
    budget.guard.hold("line", lineCost(end - start, shape));
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(bytes.subarray(start, end)));
    } catch {
      throw onError();
    }
    take(value);
    budget.guard.hold("line", 0);
    watchMemory(budget, end - start + 1);
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

function eachRow(
  entry: BackupTable,
  bytes: Uint8Array,
  manifest: BackupManifest,
  budget: LineBudget,
  take: (row: ArchiveRow) => void,
): number {
  const schema = rowSchema(entry);
  const expected = manifest.counts.tables[entry.name] ?? 0;
  const invalid = () => new RestoreRejected(E.row(entry.name));
  // A configuration table the app reads whole holds no more rows than the app lets an account have.
  const accountLimit = accountRowLimit(entry.name) ?? Number.POSITIVE_INFINITY;
  // Lines of one document, widgets of one dashboard: the app reads and renders them together.
  const perParent = Object.hasOwn(PER_PARENT_LIMITS, entry.name)
    ? PER_PARENT_LIMITS[entry.name]
    : undefined;
  const children = new Map<string, number>();
  let count = 0;
  eachLine(
    bytes,
    budget,
    budget.limits.maxLinesPerTable,
    invalid,
    (line) => {
      if (count >= accountLimit) throw new RestoreRejected(E.tooManyRows(entry.name));
      if (count >= expected) throw new RestoreRejected(E.counts);
      let upgraded: unknown;
      try {
        upgraded = upgrade(entry.name, line, manifest.v);
      } catch {
        throw invalid();
      }
      const parsed = schema.safeParse(upgraded);
      if (!parsed.success) throw invalid();
      if (perParent) {
        const parent = String(parsed.data[perParent.parent]);
        const seen = (children.get(parent) ?? 0) + 1;
        if (seen > perParent.limit) {
          throw new RestoreRejected(E.tooManyChildren(entry.name, perParent.limit));
        }
        children.set(parent, seen);
        budget.guard.hold("children", children.size * HELD_COSTS.id);
      }
      count += 1;
      take(parsed.data);
    },
    "rows",
    rowBytesFor(entry.name, budget.limits),
  );
  budget.guard.hold("children", 0);
  return count;
}

// For the registry test: every free text column of a backed-up table must have its length limit.
export function textColumnsWithoutLimit(): string[] {
  return BACKUP_TABLES.flatMap((entry) =>
    Object.values(getTableColumns(entry.table))
      .filter((column) => {
        const rule = entry.columns[column.name];
        if (!rule || rule === "omit" || rule === "owner" || rule === "id") return false;
        if (rule.startsWith("ref:") || column.columnType !== "SQLiteText") return false;
        return !(column as AnyColumn & { enumValues?: string[] }).enumValues?.length;
      })
      .map((column) => `${entry.name}.${column.name}`)
      .filter((name) => textLimit(...(name.split(".") as [string, string])) === undefined),
  );
}

// For the registry test: every JSON column of a backed-up table must have its strict shape.
export function jsonColumnsWithoutShape(): string[] {
  return BACKUP_TABLES.flatMap((entry) =>
    Object.values(getTableColumns(entry.table))
      .filter((column) => column.columnType === "SQLiteTextJson")
      .map((column) => `${entry.name}.${column.name}`)
      .filter((name) => !Object.hasOwn(KNOWN_SHAPES, name)),
  );
}

const auditLine = z.custom<object>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
);

// The audit is only archived as a file, so its lines are counted and must be JSON objects.
function auditLines(bytes: Uint8Array, manifest: BackupManifest, budget: LineBudget): number {
  const invalid = () => new RestoreRejected(E.audit);
  return eachLine(
    bytes,
    budget,
    manifest.counts.audit,
    invalid,
    (line) => {
      if (!auditLine.safeParse(line).success) throw invalid();
    },
    "audit",
  );
}

export type FileIndex = Map<string, { size: number; sha256: string }>;

// One line per blob of a version 2 archive. Each id may appear once; whether every one arrives,
// and only those, is checked against the entries that follow.
function readFileIndex(bytes: Uint8Array, budget: LineBudget): FileIndex {
  const index: FileIndex = new Map();
  const invalid = () => new RestoreRejected(E.filesIndex);
  eachLine(
    bytes,
    budget,
    budget.limits.entries,
    invalid,
    (line) => {
      const parsed = fileIndexLineSchema.safeParse(line);
      if (!parsed.success || index.has(parsed.data.id)) throw invalid();
      index.set(parsed.data.id, { size: parsed.data.size, sha256: parsed.data.sha256 });
      budget.guard.hold("files", index.size * HELD_COSTS.file);
    },
    "index",
  );
  return index;
}

const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const MAX_MANIFEST_DEPTH = 4;

// One pass over the bytes before JSON.parse: a valid manifest nests at most four levels and has
// about one object per entry, so a deep or bloated one never reaches the parser's heap.
export function prescanManifest(bytes: Uint8Array, limits: RestoreLimits): void {
  const maxContainers = limits.entries + 16;
  let depth = 0;
  let containers = 0;
  let inString = false;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (inString) {
      if (byte === BACKSLASH) i += 1;
      else if (byte === QUOTE) inString = false;
      continue;
    }
    if (byte === QUOTE) inString = true;
    else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth += 1;
      containers += 1;
      if (depth > MAX_MANIFEST_DEPTH || containers > maxContainers) {
        throw new RestoreRejected(E.manifest);
      }
    } else if (byte === 0x7d || byte === 0x5d) depth -= 1;
  }
}

function checkManifest(bytes: Uint8Array, limits: RestoreLimits): BackupManifest {
  prescanManifest(bytes, limits);
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
  if (v >= 2 && bytes.length > limits.manifestBytes) throw new RestoreRejected(E.manifest);
  for (let step = v; step < BACKUP_VERSION; step++) {
    if (!BACKUP_UPGRADES[step]) throw new RestoreRejected(E.version);
  }
  if (v === BACKUP_VERSION && columns !== backupColumnsHash()) {
    throw new RestoreRejected(E.version);
  }
  // Version 1 named every blob in the manifest; version 2 names files.jsonl instead.
  const names = Object.keys(manifest.data.entries);
  const indexed = v >= 2;
  if (
    names.includes(FILES_INDEX_ENTRY) !== indexed ||
    (indexed && names.some((name) => name.startsWith("files/")))
  ) {
    throw new RestoreRejected(E.manifest);
  }
  return manifest.data;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function entryLimit(name: string, limits: RestoreLimits = RESTORE_LIMITS): number {
  if (name === MANIFEST_ENTRY) return Math.max(limits.manifestBytes, limits.legacyManifestBytes);
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
// pass keeps (R-32). One guard may watch both passes, so growth counts from the first.
export async function scanArchive(
  path: string,
  handlers: ArchiveHandlers,
  limits: RestoreLimits = RESTORE_LIMITS,
  guard: MemoryGuard = createMemoryGuard(),
): Promise<ArchiveSummary> {
  const budget: LineBudget = {
    limits,
    total: 0,
    containers: 0,
    nodes: 0,
    guard,
    linesSinceCheck: 0,
    bytesSinceCheck: 0,
  };
  const archiveHash = createHash("sha256");
  const byName = new Map(BACKUP_TABLES.map((entry) => [`data/${entry.name}.jsonl`, entry]));
  const seen = new Set<string>();
  const counted: Record<string, number> = {};
  const files: string[] = [];
  let manifest: BackupManifest | null = null;
  let auditCount = 0;
  const fileRows: string[] = [];
  let rejection: unknown = null;
  let dataBytes = 0;
  let fileIndex: FileIndex | null = null;

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
        keepAll: true,
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
    guard.check();
    guard.hold("entry", bytes.length);
    await readEntry(name, bytes);
    guard.hold("entry", 0);
  }

  async function readEntry(name: string, bytes: Uint8Array): Promise<void> {
    if (!manifest) {
      if (name !== MANIFEST_ENTRY) throw new RestoreRejected(E.manifest);
      manifest = checkManifest(bytes, limits);
      return;
    }
    if (seen.has(name) || name === MANIFEST_ENTRY) throw new RestoreRejected(E.duplicate);
    seen.add(name);
    const blob = name.startsWith("files/");
    if (manifest.v >= 2) {
      // Version 2 order: files.jsonl, then the data and the audit, then the blobs (R-5).
      if ((name === FILES_INDEX_ENTRY) !== (seen.size === 1)) throw new RestoreRejected(E.entry);
      if (!blob && files.length > 0) throw new RestoreRejected(E.entry);
    }
    const listed = blob && fileIndex ? fileIndex : null;
    const id = name.slice("files/".length);
    const expected = listed
      ? listed.get(id)
      : Object.hasOwn(manifest.entries, name)
        ? manifest.entries[name]
        : undefined;
    if (!expected) throw new RestoreRejected(E.entry);
    if (expected.size !== bytes.length || expected.sha256 !== sha256(bytes)) {
      throw new RestoreRejected(E.hash);
    }
    const table = byName.get(name);
    if (name === FILES_INDEX_ENTRY) {
      fileIndex = readFileIndex(bytes, budget);
    } else if (table) {
      dataBytes += bytes.length;
      if (dataBytes > limits.dataTotalBytes) throw new RestoreRejected(E.dataTooLarge);
      counted[table.name] = eachRow(table, bytes, manifest, budget, (row) => {
        if (table.name === "file") fileRows.push(row.id as string);
        handlers.row?.(table, row);
      });
      await handlers.tableDone?.(table, counted[table.name]!);
    } else if (name.startsWith("files/")) {
      files.push(name.slice("files/".length));
      // A version 1 archive has no index; the blobs it names are held the same way.
      if (!fileIndex) guard.hold("files", files.length * HELD_COSTS.file);
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
    (fileIndex !== null && (fileIndex as FileIndex).size !== files.length) ||
    found.counts.audit !== auditCount ||
    !seen.has(AUDIT_ENTRY);
  const rowIds = new Set(fileRows);
  const blobsDiffer = rowIds.size !== files.length || files.some((id) => !rowIds.has(id));
  if (missing || tablesMissing || countsDiffer || blobsDiffer) throw new RestoreRejected(E.counts);
  guard.hold("files", 0);
  return { manifest: found, sha256: archiveHash.digest("hex"), files };
}
