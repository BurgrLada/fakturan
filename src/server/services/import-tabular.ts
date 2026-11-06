import "server-only";
import type { Currency } from "@/lib/currency";
import { canonicalCountry } from "@/lib/customers";
import { foldText } from "@/lib/fold-text";
import {
  importedCountry,
  type ImportDocument,
  type ImportLine,
  type ImportParty,
} from "@/lib/import-document";
import {
  applyColumns,
  type ColumnarSheet,
  dateOf,
  type FieldSpec,
  MAPPING_FIELDS,
  type MappedValue,
  type MappedRow,
  type Mapping,
  mappingSchema,
  missingColumns,
  numberOf,
  rowsLabel,
  SAMPLE_ROWS,
  type SheetFormat,
  type TabularSample,
  type TabularSheet,
  textOf,
} from "@/lib/import-mapping";
import { MAX_BATCH_DOCUMENTS, type PreviewRecord, type PreviewRow } from "@/lib/import-preview";
import { computeTotals } from "@/lib/invoice-totals";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import { parseCsv, sampleCsv } from "@/lib/safe-input/csv";
import { sniffContent, TABULAR_LIMITS } from "@/lib/safe-input/limits";
import { readXlsx } from "@/lib/safe-input/xlsx-reader";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import {
  catalogItem,
  customer,
  importBatch,
  supplier,
  type ImportBatch,
  type Job,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { readBlob } from "../files/store";
import { enqueue } from "../jobs/queue";
import { kickWorker, yieldHeavy } from "../jobs/worker";
import { ServiceError, type Reader } from "./access";
import { catalogInputSchema, type CatalogInput } from "./catalog";
import { customerInputSchema, type CustomerInput } from "./customers";
import { analyzeRows, type RowDecisions, type RowInput, TABULAR_SOURCE } from "./import-analyze";
import { findBatch, readPreview, uploadsOf, writePreview } from "./import-batch";
import { mutate } from "./mutation";

const E = TEXTS.importing.errors;
const M = TEXTS.importing.mapping;
const R = TEXTS.importing.rows;
const DEFAULT_UNIT = "ks";
const RATE_ONE = 1_000_000;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(TEXTS.invoices.validation.forbidden);
  return actor.userId;
}

const digits = (value: string) => value.replace(/\s+/g, "");
const blank = (cells: string[]) => cells.every((cell) => cell.trim() === "");

async function readWorkbook(bytes: Uint8Array): Promise<TabularSheet> {
  const sheet = await readXlsx(bytes, TABULAR_LIMITS);
  const [headers = [], ...rows] = sheet.rows;
  return { format: "xlsx", headers: headers.map((h) => h.trim()), rows };
}

// The type comes from the bytes: a workbook is a ZIP, anything else must read as text.
function formatOf(bytes: Uint8Array): SheetFormat {
  const kind = sniffContent(bytes);
  if (kind === "zip") return "xlsx";
  if (kind !== "text") throw new ServiceError(M.errors.unsupported);
  return "csv";
}

// The mapping step: the header, the first rows and the count, never the sheet as rows.
async function readSample(bytes: Uint8Array): Promise<TabularSample> {
  if (formatOf(bytes) === "xlsx") {
    const sheet = await readWorkbook(bytes);
    return {
      format: "xlsx",
      headers: sheet.headers,
      rows: sheet.rows.slice(0, SAMPLE_ROWS),
      total: sheet.rows.filter((cells) => !blank(cells)).length,
    };
  }
  const csv = await sampleCsv(bytes, SAMPLE_ROWS);
  return { format: "csv", ...csv };
}

function mappedIndexes(headers: string[], mapping: Mapping): number[] {
  const wanted = new Set(Object.values(mapping.columns));
  const seen = new Set<string>();
  return headers.flatMap((header, at) => {
    const name = header.trim();
    if (!wanted.has(name) || seen.has(name)) return [];
    seen.add(name);
    return [at];
  });
}

// R-14 of plan 9: one pass over the file, keeping only the mapped columns.
export async function readSheetOnce(
  bytes: Uint8Array,
  mapping: Mapping,
): Promise<ColumnarSheet & { format: SheetFormat }> {
  if (formatOf(bytes) === "csv") {
    const csv = await parseCsv(bytes, { pick: (headers) => mappedIndexes(headers, mapping) });
    return { format: "csv", headers: csv.headers, columns: csv.columns, rows: csv.rows };
  }
  const sheet = await readWorkbook(bytes);
  const picked = mappedIndexes(sheet.headers, mapping);
  return {
    format: "xlsx",
    headers: picked.map((at) => sheet.headers[at]!),
    columns: picked.map((at) => sheet.rows.map((cells) => cells[at] ?? "")),
    rows: sheet.rows.length,
  };
}

export function getSample(ownerId: string, batchId: string): TabularSample | null {
  return readPreview(ownerId, batchId)?.sample ?? null;
}

function previewRow(key: string, source: string, messages: string[]): PreviewRow {
  return {
    key,
    source,
    document: null,
    status: messages.length > 0 ? "error" : "ok",
    skippedFrom: null,
    messages,
    customerAction: { kind: "none" },
    paidOn: null,
    paidMinor: 0,
    dateEstimated: false,
    ownConfirmed: null,
    original: null,
    advance: null,
    pdfFileId: null,
  };
}

export type RecordInput = {
  key: string;
  source: string;
  record: PreviewRecord | null;
  errors: string[];
};

// Schema paths that differ from the mapping field they come from.
const FIELD_OF_PATH: Record<string, string> = { priceMinor: "price" };

function issueText(
  row: MappedRow,
  mapping: Mapping,
  issue: { path: PropertyKey[]; message: string } | undefined,
): string {
  const path = String(issue?.path[0] ?? "");
  const column = mapping.columns[FIELD_OF_PATH[path] ?? path];
  const message = issue?.message ?? M.errors.invalid;
  return column ? M.errors.field(row.line, column, message) : M.errors.row(row.line, message);
}

function customerInputFrom(row: MappedRow): CustomerInput {
  return {
    name: textOf(row, "name"),
    street: textOf(row, "street"),
    city: textOf(row, "city"),
    zip: textOf(row, "zip"),
    country: textOf(row, "country"),
    ico: textOf(row, "ico"),
    dic: textOf(row, "dic"),
    email: textOf(row, "email"),
    extraEmails: [],
    phone: textOf(row, "phone"),
    note: textOf(row, "note"),
    dueDays: numberOf(row, "dueDays"),
    language: null,
    currency: (textOf(row, "currency").toUpperCase() || null) as CustomerInput["currency"],
    designId: null,
    remindersEnabled: null,
  };
}

function catalogInputFrom(row: MappedRow, mapping: Mapping): CatalogInput {
  return {
    name: textOf(row, "name"),
    description: textOf(row, "description"),
    unit: textOf(row, "unit") || DEFAULT_UNIT,
    priceMinor: numberOf(row, "price") ?? 0,
    currency: (textOf(row, "currency") || mapping.currency).toUpperCase() as Currency,
    category: textOf(row, "category"),
    tags: [],
  };
}

export function recordInputs(mapped: MappedRow[], mapping: Mapping): RecordInput[] {
  return mapped.map((row, i) => {
    const base = { key: `r${i + 1}`, source: rowsLabel([row.line]) };
    if (row.errors.length > 0) return { ...base, record: null, errors: row.errors };
    if (mapping.target === "customers") {
      const input = customerInputFrom(row);
      const parsed = customerInputSchema.safeParse(input);
      if (!parsed.success) {
        return { ...base, record: null, errors: [issueText(row, mapping, parsed.error.issues[0])] };
      }
      const { ico, city, name } = parsed.data;
      return {
        ...base,
        errors: [],
        record: {
          target: "customers",
          input,
          name,
          detail: [ico && `IČO ${ico}`, city].filter(Boolean).join(" · "),
        },
      };
    }
    const input = catalogInputFrom(row, mapping);
    const parsed = catalogInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ...base, record: null, errors: [issueText(row, mapping, parsed.error.issues[0])] };
    }
    const { name, priceMinor, currency, unit } = parsed.data;
    return {
      ...base,
      errors: [],
      record: {
        target: "catalog",
        input,
        name,
        detail: `${formatMoney(priceMinor, currency)} / ${unit}`,
      },
    };
  });
}

// R-17 for tables: an existing customer or item is never overwritten, a match is a duplicate.
export function analyzeRecords(
  q: Reader,
  ownerId: string,
  inputs: RecordInput[],
  decisions: Map<string, Pick<RowDecisions, "status">> = new Map(),
): PreviewRow[] {
  const customers = q
    .select({ name: customer.name, ico: customer.ico })
    .from(customer)
    .where(scoped(ownerId).where(customer))
    .all();
  const items = q
    .select({ name: catalogItem.name, currency: catalogItem.currency })
    .from(catalogItem)
    .where(scoped(ownerId).where(catalogItem))
    .all();
  const taken = new Set([
    ...customers.flatMap((row) => (digits(row.ico) ? [`ico:${digits(row.ico)}`] : [])),
    ...customers.map((row) => `name:${foldText(row.name.trim())}`),
    ...items.map((row) => `item:${foldText(row.name.trim())}|${row.currency}`),
  ]);
  return inputs.map((input) => {
    const row = previewRow(input.key, input.source, [...input.errors]);
    if (input.record) row.record = input.record;
    else if (row.messages.length === 0) row.messages.push(M.errors.invalid);
    if (input.record && row.status === "ok") {
      const values = input.record.input;
      const key =
        input.record.target === "customers"
          ? digits(String(values.ico ?? ""))
            ? `ico:${digits(String(values.ico))}`
            : `name:${foldText(input.record.name)}`
          : `item:${foldText(input.record.name)}|${String(values.currency)}`;
      if (taken.has(key)) {
        row.status = "duplicate";
        row.messages.push(
          input.record.target === "customers" ? R.duplicateCustomer : R.duplicateItem,
        );
      }
      taken.add(key);
    }
    row.status = row.messages.length > 0 && row.status === "ok" ? "error" : row.status;
    if (decisions.get(row.key)?.status === "skipped") {
      row.skippedFrom = row.status;
      row.status = "skipped";
    }
    return row;
  });
}

function supplierParty(q: Reader, ownerId: string): { party: ImportParty; vat: boolean } {
  const row = q.select().from(supplier).where(scoped(ownerId).where(supplier)).get();
  return {
    party: {
      name: row?.name ?? "",
      street: row?.street ?? "",
      city: row?.city ?? "",
      zip: row?.zip ?? "",
      country: row?.country ?? "",
      ico: digits(row?.ico ?? ""),
      dic: digits(row?.dic ?? ""),
      email: row?.email ?? "",
      phone: row?.phone ?? "",
    },
    vat: row?.vatIdentified ?? false,
  };
}

class LineInvalid extends Error {}

// Half away from zero on the magnitude, in integers: total × 1000 / quantity exceeds 2^53 early.
function unitPriceOf(totalMinor: number, quantityMilli: number): number {
  const magnitude = BigInt(Math.abs(totalMinor)) * BigInt(1000);
  const quantity = BigInt(quantityMilli);
  const rounded = Number((BigInt(2) * magnitude + quantity) / (BigInt(2) * quantity));
  return totalMinor < 0 ? -rounded : rounded;
}

// A value of the whole document may repeat on further lines of its number, but never differ:
// two documents that share a number must not merge into one.
function headerConflicts(rows: MappedRow[], mapping: Mapping): string[] {
  const [first, ...rest] = rows;
  const fields = MAPPING_FIELDS.invoices as Record<string, FieldSpec>;
  const same = (field: string, value: MappedValue | undefined) =>
    typeof value === "string" && field === "currency" ? value.toUpperCase() : value;
  const conflicts: string[] = [];
  for (const row of rest) {
    for (const [field, spec] of Object.entries(fields)) {
      const column = mapping.columns[field];
      const value = row.values[field];
      if (!spec.document || !column || value === null || value === "" || value === undefined) {
        continue;
      }
      if (same(field, value) !== same(field, first!.values[field])) {
        conflicts.push(
          M.errors.headerMismatch(row.line, textOf(first!, "number"), column, first!.line),
        );
      }
    }
  }
  return conflicts;
}

function lineOf(row: MappedRow, mapping: Mapping): ImportLine {
  const quantityMilli = numberOf(row, "lineQuantity") ?? 1000;
  const price = numberOf(row, "lineUnitPrice");
  const total = numberOf(row, "lineTotal");
  if (quantityMilli < 0) throw new LineInvalid(M.errors.lineAmount(row.line));
  let netMinor: number;
  let unitPriceMinor: number;
  if (total !== null) {
    netMinor = total;
    unitPriceMinor = price ?? (quantityMilli > 0 ? unitPriceOf(total, quantityMilli) : total);
  } else if (price !== null) {
    try {
      netMinor = computeTotals(
        [{ quantityMilli, unitPriceMinor: price, discount: { kind: "none" } }],
        { kind: "none" },
        "none",
      ).lines[0]!.netMinor;
    } catch {
      throw new LineInvalid(M.errors.lineAmount(row.line));
    }
    unitPriceMinor = price;
  } else {
    const column = mapping.columns.lineTotal ?? mapping.columns.lineUnitPrice ?? "";
    throw new LineInvalid(M.errors.missingValue(row.line, column));
  }
  return {
    name: textOf(row, "lineName"),
    description: textOf(row, "lineDescription"),
    quantityMilli,
    unit: textOf(row, "lineUnit"),
    unitPriceMinor,
    netMinor,
  };
}

function documentOf(
  rows: MappedRow[],
  mapping: Mapping,
  own: { party: ImportParty; vat: boolean },
  today: CalendarDate,
): ImportDocument {
  const first = rows[0]!;
  const issueDate = dateOf(first, "issueDate");
  if (!issueDate)
    throw new LineInvalid(M.errors.missingValue(first.line, mapping.columns.issueDate!));
  const lines = rows.map((row) => lineOf(row, mapping));
  const paidOn = dateOf(first, "paidOn");
  if (paidOn && paidOn > today) {
    throw new LineInvalid(M.errors.futurePaid(first.line, mapping.columns.paidOn!));
  }
  const currency = (textOf(first, "currency") || mapping.currency).toUpperCase();
  const subtotalMinor = lines.reduce((sum, line) => sum + line.netMinor, 0);
  const totalMinor = numberOf(first, "total") ?? subtotalMinor;
  const rate = currency === "CZK" ? null : numberOf(first, "exchangeRate");
  const name = textOf(first, "customerName");
  return {
    type: "invoice",
    sourceType: TABULAR_SOURCE,
    isdocVersion: null,
    number: textOf(first, "number"),
    uuid: null,
    issueDate,
    taxableDate: dateOf(first, "taxableDate"),
    dueDate: dateOf(first, "dueDate"),
    supplier: own.party,
    customer: name
      ? {
          name,
          street: textOf(first, "customerStreet"),
          city: textOf(first, "customerCity"),
          zip: textOf(first, "customerZip"),
          country: canonicalCountry(importedCountry(textOf(first, "customerCountry"))),
          ico: digits(textOf(first, "customerIco")),
          dic: digits(textOf(first, "customerDic")).toUpperCase(),
          email: textOf(first, "customerEmail"),
          phone: "",
        }
      : null,
    lines,
    currency,
    // R-13: a missing rate or a rate of one in a foreign currency stays unconverted.
    exchangeRateMicros: rate !== null && rate > 0 && rate !== RATE_ONE ? rate : null,
    subtotalMinor,
    roundingMinor: totalMinor - subtotalMinor,
    totalMinor,
    payableMinor: paidOn ? 0 : totalMinor,
    paidDepositsMinor: 0,
    variableSymbol: textOf(first, "variableSymbol") || null,
    account: null,
    originalDocuments: [],
    deposits: [],
    vatApplicable: own.vat,
    note: textOf(first, "note"),
    issuingSystem: null,
    paidOn,
  };
}

// The number column decides the document; every further line with the same number is an item.
export function invoiceInputs(
  q: Reader,
  ownerId: string,
  mapped: MappedRow[],
  mapping: Mapping,
  today: CalendarDate,
): RowInput[] {
  const own = supplierParty(q, ownerId);
  const groups: MappedRow[][] = [];
  const byNumber = new Map<string, MappedRow[]>();
  for (const row of mapped) {
    const number = textOf(row, "number");
    if (!number) {
      groups.push([row]);
      continue;
    }
    const group = byNumber.get(number);
    if (group) group.push(row);
    else {
      const created = [row];
      byNumber.set(number, created);
      groups.push(created);
    }
  }
  return groups.map((rows, i) => {
    const input: RowInput = {
      key: `r${i + 1}`,
      source: rowsLabel(rows.map((row) => row.line)),
      document: null,
      errors: rows.flatMap((row) => row.errors),
      pdfFileId: null,
    };
    if (input.errors.length === 0) input.errors.push(...headerConflicts(rows, mapping));
    if (input.errors.length > 0) return input;
    try {
      input.document = documentOf(rows, mapping, own, today);
    } catch (error) {
      if (!(error instanceof LineInvalid)) throw error;
      input.errors.push(error.message);
    }
    return input;
  });
}

export type TabularResult = {
  status: "mapping" | "ready";
  rows: PreviewRow[];
  sample: TabularSample;
};

// The first pass only reads the header and a sample; the rows come once the mapping is known.
export async function parseTabular(
  job: Job,
  ownerId: string,
  batch: ImportBatch,
): Promise<TabularResult> {
  const [upload] = uploadsOf(db, ownerId, batch.id);
  if (!upload) throw new ServiceError(E.empty);
  const bytes = new Uint8Array(readBlob(ownerId, upload.id));
  if (job.payload.step !== "rows") {
    const sample = await readSample(bytes);
    if (sample.headers.every((header) => !header)) throw new ServiceError(M.errors.noHeader);
    await yieldHeavy(job);
    return { status: "mapping", rows: [], sample };
  }

  const sample = readPreview(ownerId, batch.id)?.sample;
  if (!sample) throw new ServiceError(E.notFound);
  const parsed = mappingSchema.safeParse(batch.mapping);
  if (!parsed.success) throw new ServiceError(M.errors.invalid);
  const mapping = parsed.data;
  const missing = missingColumns(sample.headers, mapping);
  if (missing.length > 0) throw new ServiceError(M.errors.missingColumns(missing.join(", ")));
  const mapped = applyColumns(await readSheetOnce(bytes, mapping), mapping);
  if (mapped.length === 0) throw new ServiceError(M.errors.noRows);
  await yieldHeavy(job);
  const today = calendarDateInPrague(clock.now());
  const rows =
    mapping.target === "invoices"
      ? analyzeRows(db, ownerId, guarded(invoiceInputs(db, ownerId, mapped, mapping, today)), today)
      : analyzeRecords(db, ownerId, guarded(recordInputs(mapped, mapping)));
  return { status: "ready", rows, sample };
}

function guarded<T>(inputs: T[]): T[] {
  if (inputs.length > MAX_BATCH_DOCUMENTS) throw new ServiceError(E.tooMany(MAX_BATCH_DOCUMENTS));
  return inputs;
}

export function submitMapping(actor: Actor, batchId: string, revision: number, raw: unknown): void {
  const userId = ownerOf(actor);
  const parsed = mappingSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? M.errors.invalid);
  const mapping = parsed.data;
  mutate(actor, "import.mapping", (tx, audit) => {
    const batch = findBatch(tx, userId, batchId);
    if (batch.kind !== "tabular" || batch.status !== "mapping") throw new ServiceError(E.status);
    if (batch.revision !== revision) throw new ServiceError(E.stale);
    const sample = readPreview(userId, batchId)?.sample;
    if (!sample) throw new ServiceError(E.notFound);
    const missing = missingColumns(sample.headers, mapping);
    if (missing.length > 0) throw new ServiceError(M.errors.missingColumns(missing.join(", ")));
    const next = batch.revision + 1;
    tx.update(importBatch)
      .set({
        status: "parsing",
        target: mapping.target,
        mapping,
        sourceSystem: mapping.target === "invoices" ? mapping.source : null,
        revision: next,
        progress: 0,
        error: null,
        updatedAt: clock.now(),
      })
      .where(scoped(userId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .run();
    enqueue(tx, {
      kind: "import.parse",
      key: `import:parse:${batchId}:${next}`,
      userId,
      payload: { batchId, step: "rows" },
    });
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId: userId,
      scope: "user",
      after: { status: "parsing", target: mapping.target, columns: Object.keys(mapping.columns) },
    });
  });
  kickWorker();
}

export function remapBatch(actor: Actor, batchId: string, revision: number): void {
  const userId = ownerOf(actor);
  mutate(actor, "import.remap", (tx, audit) => {
    const batch = findBatch(tx, userId, batchId);
    if (batch.kind !== "tabular" || batch.status !== "ready") throw new ServiceError(E.status);
    if (batch.revision !== revision) throw new ServiceError(E.stale);
    const sample = readPreview(userId, batchId)?.sample;
    if (!sample) throw new ServiceError(E.notFound);
    tx.update(importBatch)
      .set({
        status: "mapping",
        revision: batch.revision + 1,
        summary: null,
        error: null,
        updatedAt: clock.now(),
      })
      .where(scoped(userId).where(importBatch, (t, { eq }) => eq(t.id, batchId)))
      .run();
    audit({
      entity: "import_batch",
      entityId: batchId,
      ownerId: userId,
      scope: "user",
      after: { status: "mapping" },
    });
    // Last in the transaction: a failed write takes the state back with it.
    writePreview(userId, batchId, { rows: [], sample });
  });
}
