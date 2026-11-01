import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { foldText } from "@/lib/fold-text";
import { suggestedClause } from "@/lib/clauses";
import { EXCHANGE_RATE_SOURCES, MAX_EXCHANGE_RATE_MICROS } from "@/lib/fx";
import {
  addDays,
  appearanceFrom,
  AWAITING_PAYMENT,
  daysBetween,
  INVOICE_STATUSES,
  INVOICE_TYPES,
  isOverdue,
  toDiscount,
  type InvoiceStatus,
  type InvoiceType,
} from "@/lib/invoice";
import { diffLines, lineBody } from "@/lib/invoice-diff";
import {
  allowsNegativePrice,
  computeTotals,
  DISCOUNT_KINDS,
  MAX_DOCUMENT_MINOR,
  MAX_QUANTITY_MILLI,
  ROUNDING_MODES,
  type DiscountKind,
  type Totals,
} from "@/lib/invoice-totals";
import { AmountOutOfRangeError } from "@/lib/money";
import { calendarDateInPrague, isCalendarDate } from "@/lib/number-format";
import { defaultIssueDate, LANGUAGES, PAYMENT_METHODS } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  bankAccount,
  catalogItem,
  customer,
  invoice,
  invoiceLine,
  invoiceTag,
  numberSeries,
} from "../db/schema";
import { czech } from "../db/collation";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import type { Page } from "./audit-read";
import { defaultAccountFor } from "./bank-accounts";
import { MAX_PRICE_MINOR } from "./catalog";
import { customerDefaults, escapeLike } from "./customers";
import { mutate, type Audit } from "./mutation";
import { defaultSeriesFor } from "./number-series";
import { averagePaymentDays } from "./payments";
import { colorSchema, designIdSchema, getPreferences, logoPositionSchema } from "./preferences";
import { clauseDefaultsOf } from "./supplier";
import { linkTags, listTags, tagsOf, type Tag } from "./tags";

const V = TEXTS.invoices.validation;
const MAX_LINES = 500;
const MAX_NUMBER = 100;
export const MAX_LINE_NAME = 200;
export const MAX_REFERENCE = 200;
export const MAX_DOCUMENT_TEXT = 2000;
export const MANUAL_VARIABLE_SYMBOL = /^\d{0,10}$/;

export type Invoice = typeof invoice.$inferSelect;
export type InvoiceLine = typeof invoiceLine.$inferSelect;
export type InvoiceDetail = Invoice & { lines: InvoiceLine[]; tags: Tag[] };

const text = (max: number) => z.string(V.invalid).trim().max(max, V.tooLong);
const reference = z.string(V.invalid).min(1, V.invalid).nullable();
const date = z.string(V.date).refine(isCalendarDate, V.date).nullable();

const DISCOUNT_LIMIT: Record<DiscountKind, number> = {
  none: Number.MAX_SAFE_INTEGER,
  percent: 10_000,
  amount: MAX_DOCUMENT_MINOR,
};

const discountFields = {
  discountKind: z.enum(DISCOUNT_KINDS, V.discount),
  discountValue: z.number(V.discount).int(V.discount).min(0, V.discount),
};

export function checkDiscount(
  value: { discountKind: DiscountKind; discountValue: number },
  ctx: z.RefinementCtx,
): void {
  if (value.discountValue > DISCOUNT_LIMIT[value.discountKind]) {
    ctx.addIssue({
      code: "custom",
      path: ["discountValue"],
      message: V.discount,
    });
  }
}

export function withoutStrayDiscount<
  T extends { discountKind: DiscountKind; discountValue: number },
>(value: T): T {
  return value.discountKind === "none" ? { ...value, discountValue: 0 } : value;
}

const lineSchema = z
  .object({
    catalogItemId: reference,
    name: text(MAX_LINE_NAME),
    description: text(MAX_DOCUMENT_TEXT),
    quantityMilli: z
      .number(V.quantity)
      .int(V.quantity)
      .min(0, V.quantity)
      .max(MAX_QUANTITY_MILLI, V.quantity),
    unit: text(20),
    // A catalog price may exceed the document limit; computeTotals decides from the line amount.
    unitPriceMinor: z
      .number(V.price)
      .int(V.price)
      .min(-MAX_PRICE_MINOR, V.price)
      .max(MAX_PRICE_MINOR, V.price),
    ...discountFields,
  })
  .superRefine(checkDiscount)
  .transform(withoutStrayDiscount);

export function checkPriceSign(
  value: { type: InvoiceType; lines: { unitPriceMinor: number }[] },
  ctx: z.RefinementCtx,
): void {
  if (allowsNegativePrice(value.type)) return;
  value.lines.forEach((line, i) => {
    if (line.unitPriceMinor < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "unitPriceMinor"],
        message: V.negativePrice,
      });
    }
  });
}

const appearanceSchema = z.object({
  designId: designIdSchema,
  colors: z.object({
    accent: colorSchema,
    surface: colorSchema,
    text: colorSchema,
    line: colorSchema,
  }),
  logoPosition: logoPositionSchema,
  showLogo: z.boolean(V.invalid),
  showQr: z.boolean(V.invalid),
  showQrLogo: z.boolean(V.invalid),
  showSignature: z.boolean(V.invalid),
  showDuzp: z.boolean(V.invalid),
});

export const documentFields = {
  bankAccountId: reference,
  issueDate: date,
  dueDate: date,
  taxableDate: date,
  language: z.enum(LANGUAGES, V.language),
  currency: z.enum(CURRENCIES, V.currency),
  exchangeRateMicros: z
    .number(V.exchangeRate)
    .int(V.exchangeRate)
    .positive(V.exchangeRate)
    .max(MAX_EXCHANGE_RATE_MICROS, V.exchangeRate)
    .nullable(),
  exchangeRateSource: z.enum(EXCHANGE_RATE_SOURCES, V.exchangeRate).nullable().default(null),
  foreign: z.boolean(V.invalid).default(false),
  clause: text(MAX_DOCUMENT_TEXT).default(""),
  paymentMethod: z.enum(PAYMENT_METHODS, V.paymentMethod),
  orderRef: text(MAX_REFERENCE),
  reference: text(MAX_REFERENCE),
  textBefore: text(MAX_DOCUMENT_TEXT),
  textAfter: text(MAX_DOCUMENT_TEXT),
  note: text(MAX_DOCUMENT_TEXT),
  ...discountFields,
  rounding: z.enum(ROUNDING_MODES, V.rounding),
  appearance: appearanceSchema,
  lines: z.array(lineSchema, V.invalid).max(MAX_LINES, V.tooManyLines),
};

// Deliberately lenient beyond ranges and references: strict checks wait for issuing.
export const draftInputSchema = z
  .object({
    id: z.string(V.invalid).min(1, V.invalid).optional(),
    // Chosen by the form, so a repeated first write finds the draft instead of creating another.
    clientId: z.uuid(V.invalid).optional(),
    revision: z.number(V.invalid).int(V.invalid).optional(),
    type: z.enum(INVOICE_TYPES, V.type),
    customerId: reference,
    seriesId: reference,
    ...documentFields,
  })
  .superRefine(checkDiscount)
  .superRefine(checkPriceSign)
  .transform(withoutStrayDiscount);

// Type, customer and series are absent on purpose: the customer changes only through
// refreshCustomerSnapshot (CUS-008). A missing revision is reported as stale by the service.
export const issuedInputSchema = z
  .object({
    revision: z.number(V.invalid).int(V.invalid).nullish(),
    number: z.string(V.number).trim().min(1, V.number).max(MAX_NUMBER, V.number),
    variableSymbol: z
      .string(V.variableSymbol)
      .trim()
      .regex(MANUAL_VARIABLE_SYMBOL, V.variableSymbol)
      .nullish(),
    ...documentFields,
  })
  .superRefine(checkDiscount)
  .transform(withoutStrayDiscount);

export type DraftInput = z.input<typeof draftInputSchema>;
export type IssuedInput = z.input<typeof issuedInputSchema>;
export type ParsedDraft = z.output<typeof draftInputSchema>;
type DraftLine = ParsedDraft["lines"][number];

export type DraftOrigin = { recurringId: string; periodFrom: string; periodTo: string };

export type SavedDraft = { id: string; revision: number; totals: Totals };

export function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(V.forbidden);
  return actor.userId;
}

function readOwned(q: Reader, ownerId: string, id: string): Invoice | null {
  return (
    q
      .select()
      .from(invoice)
      .where(scoped(ownerId).where(invoice, (t, { eq }) => eq(t.id, id)))
      .get() ?? null
  );
}

export function findOwned(q: Reader, ownerId: string, id: string): Invoice {
  const row = readOwned(q, ownerId, id);
  if (!row) throw new ServiceError(V.notFound);
  return row;
}

export function linesOf(q: Reader, ownerId: string, invoiceId: string): InvoiceLine[] {
  return q
    .select()
    .from(invoiceLine)
    .where(scoped(ownerId).where(invoiceLine, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .orderBy(asc(invoiceLine.position))
    .all();
}

export function getInvoice(ownerId: string, id: string): InvoiceDetail | null {
  const row = readOwned(db, ownerId, id);
  if (!row) return null;
  return {
    ...row,
    lines: linesOf(db, ownerId, id),
    tags: tagsOf(db, ownerId, id),
  };
}

// A form opens under an id chosen in advance, so the address stays valid before the first save.
export function isFreeDraftId(id: string): boolean {
  if (!z.uuid().safeParse(id).success) return false;
  return !db.select({ id: invoice.id }).from(invoice).where(eq(invoice.id, id)).get();
}

export function newDraftDefaults(
  ownerId: string,
  customerId: string | null,
  type: InvoiceType = "invoice",
): DraftInput {
  const prefs = getPreferences(ownerId);
  const defaults = customerId
    ? customerDefaults(ownerId, customerId, prefs)
    : { ...prefs, foreign: false, dic: "" };
  const { vatIdentified, texts } = clauseDefaultsOf(ownerId);
  const issueDate = defaultIssueDate(defaults.issueDateMode, clock.now());
  return {
    type,
    customerId,
    bankAccountId: defaultAccountFor(ownerId, defaults.currency)?.id ?? null,
    seriesId: defaultSeriesFor(ownerId, type)?.id ?? null,
    issueDate,
    dueDate: addDays(issueDate, defaults.dueDays),
    taxableDate: null,
    language: defaults.language,
    currency: defaults.currency,
    exchangeRateMicros: null,
    foreign: defaults.foreign,
    clause: suggestedClause({
      foreign: defaults.foreign,
      language: defaults.language,
      vatIdentified,
      customerDic: defaults.dic,
      texts,
    }),
    paymentMethod: defaults.paymentMethod,
    orderRef: "",
    reference: "",
    textBefore: defaults.textBefore,
    textAfter: defaults.textAfter,
    note: defaults.note,
    discountKind: "none",
    discountValue: 0,
    rounding: defaults.rounding,
    appearance: appearanceFrom(defaults),
    lines: [],
  };
}

export function totalsOf(
  lines: Pick<DraftLine, "quantityMilli" | "unitPriceMinor" | "discountKind" | "discountValue">[],
  draft: Pick<ParsedDraft, "discountKind" | "discountValue" | "rounding">,
): Totals {
  try {
    return computeTotals(
      lines.map((line) => ({
        quantityMilli: line.quantityMilli,
        unitPriceMinor: line.unitPriceMinor,
        discount: toDiscount(line.discountKind, line.discountValue),
      })),
      toDiscount(draft.discountKind, draft.discountValue),
      draft.rounding,
    );
  } catch (error) {
    if (error instanceof AmountOutOfRangeError) throw new ServiceError(V.amountRange);
    throw error;
  }
}

function assertOwned(
  tx: Tx,
  ownerId: string,
  table: typeof customer | typeof bankAccount | typeof numberSeries,
  id: string | null,
  message: string,
): void {
  if (!id) return;
  const row = tx
    .select({ id: table.id })
    .from(table)
    .where(scoped(ownerId).where(table, (t, { eq }) => eq(t.id, id)))
    .get();
  if (!row) throw new ServiceError(message);
}

// The foreign keys only prove a row exists, not that it belongs to this account.
export function assertReferencesOwned(
  tx: Tx,
  ownerId: string,
  draft: Pick<ParsedDraft, "customerId" | "bankAccountId" | "seriesId" | "lines">,
): void {
  assertOwned(tx, ownerId, customer, draft.customerId, V.customerNotFound);
  assertOwned(tx, ownerId, bankAccount, draft.bankAccountId, V.accountNotFound);
  assertOwned(tx, ownerId, numberSeries, draft.seriesId, V.seriesNotFound);
  const itemIds = [...new Set(draft.lines.flatMap((l) => l.catalogItemId ?? []))];
  if (itemIds.length === 0) return;
  const found = tx
    .select({ id: catalogItem.id })
    .from(catalogItem)
    .where(scoped(ownerId).where(catalogItem, (t) => inArray(t.id, itemIds)))
    .all();
  if (found.length !== itemIds.length) throw new ServiceError(V.catalogItemNotFound);
}

function draftWithClientId(tx: Tx, ownerId: string, clientId: string): Invoice | null {
  const own = readOwned(tx, ownerId, clientId);
  if (own) return own;
  const taken = tx.select({ id: invoice.id }).from(invoice).where(eq(invoice.id, clientId)).get();
  if (taken) throw new ServiceError(V.notFound);
  return null;
}

function customerNameOf(tx: Tx, ownerId: string, customerId: string | null): string {
  if (!customerId) return "";
  return (
    tx
      .select({ name: customer.name })
      .from(customer)
      .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, customerId)))
      .get()?.name ?? ""
  );
}

export function searchTextOf(row: {
  number?: string | null;
  customerName: string;
  lines: { name: string }[];
}): string {
  return foldText(
    [row.number ?? "", row.customerName, ...row.lines.map((line) => line.name)].join("\n"),
  );
}

export function sumsOf(totals: Totals) {
  const { subtotalMinor, discountMinor, roundingMinor, totalMinor } = totals;
  return { subtotalMinor, discountMinor, roundingMinor, totalMinor };
}

export function lineRows(lines: DraftLine[], totals: Totals) {
  return lines.map((line, position) => ({
    ...line,
    position,
    netMinor: totals.lines[position]!.netMinor,
  }));
}

export function insertLines(
  tx: Tx,
  ownerId: string,
  invoiceId: string,
  rows: ReturnType<typeof lineRows>,
): void {
  for (const row of rows) {
    tx.insert(invoiceLine)
      .values({ id: randomUUID(), invoiceId, userId: ownerId, ...row })
      .run();
  }
}

export function matches<T extends object>(row: object, wanted: T): boolean {
  const current = Object.fromEntries(
    Object.keys(wanted).map((key) => [key, (row as Record<string, unknown>)[key]]),
  );
  return isDeepStrictEqual(current, wanted);
}

export function auditSnapshot(row: Invoice, lineCount: number) {
  const { userId: _u, createdAt: _c, updatedAt: _t, searchText: _s, ...rest } = row;
  return { ...rest, lineCount };
}

// Thrown to roll back: mutate refuses a transaction without an audit entry.
export class Unchanged<T> extends Error {
  readonly result: T;

  constructor(result: T) {
    super();
    this.result = result;
  }
}

export function unlessUnchanged<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof Unchanged) return error.result as T;
    throw error;
  }
}

export function parseDraft(raw: DraftInput): ParsedDraft {
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  return parsed.data;
}

type RateFields = Pick<Invoice, "exchangeRateMicros" | "exchangeRateSource" | "exchangeRateDate">;

const NO_RATE: RateFields = {
  exchangeRateMicros: null,
  exchangeRateSource: null,
  exchangeRateDate: null,
};

// CZK never carries a rate, whatever the caller sent (R-18). A rate that stayed keeps where it came
// from, a different one was set by a person (R-17) unless the form says it came from a lookup. Only
// the server knows the list date, so a changed source loses it.
export function normalizedRate(
  next: Pick<Invoice, "currency" | "exchangeRateMicros">,
  before: Invoice | null,
  requested: Invoice["exchangeRateSource"] = null,
): RateFields {
  const { currency, exchangeRateMicros } = next;
  if (currency === "CZK" || exchangeRateMicros === null) return NO_RATE;
  const kept =
    before?.currency === currency && before.exchangeRateMicros === exchangeRateMicros
      ? before
      : null;
  const previous = kept ? kept.exchangeRateSource : "manual";
  const exchangeRateSource = requested ?? previous;
  return {
    exchangeRateMicros,
    exchangeRateSource,
    exchangeRateDate: exchangeRateSource === previous ? (kept?.exchangeRateDate ?? null) : null,
  };
}

// Runs before the unchanged comparison: a forged credit note must not pass as a repeated write.
function assertDraftIdentity(
  before: Invoice,
  next: Pick<ParsedDraft, "type" | "customerId" | "currency" | "exchangeRateMicros">,
): void {
  if (next.type === "credit_note" && !before.relatedInvoiceId) {
    throw new ServiceError(V.creditNoteManual);
  }
  if (!before.relatedInvoiceId) {
    if (next.type !== before.type) throw new ServiceError(V.typeLocked);
    return;
  }
  const locked =
    next.type !== before.type ||
    next.customerId !== before.customerId ||
    next.currency !== before.currency ||
    (before.type === "credit_note" && next.exchangeRateMicros !== before.exchangeRateMicros);
  if (locked) throw new ServiceError(V.linkedLocked);
}

export function createDraftIn(
  tx: Tx,
  audit: Audit,
  userId: string,
  input: ParsedDraft,
  origin?: DraftOrigin,
  auditNote: Record<string, unknown> = {},
): SavedDraft {
  const { id: _i, clientId, revision: _r, lines, ...fields } = input;
  if (fields.type === "credit_note") throw new ServiceError(V.creditNoteManual);
  const totals = totalsOf(lines, fields);
  const rows = lineRows(lines, totals);
  assertReferencesOwned(tx, userId, input);
  const customerName = customerNameOf(tx, userId, fields.customerId);
  const id = clientId ?? randomUUID();
  const now = clock.now();
  tx.insert(invoice)
    .values({
      id,
      userId,
      ...fields,
      ...normalizedRate(fields, null, fields.exchangeRateSource),
      ...origin,
      ...sumsOf(totals),
      customerName,
      searchText: searchTextOf({ customerName, lines: rows }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  insertLines(tx, userId, id, rows);
  const changes = diffLines([], rows);
  audit({
    action: "invoice.save",
    entity: "invoice",
    entityId: id,
    ownerId: userId,
    scope: "user",
    before: null,
    after: {
      ...auditNote,
      ...auditSnapshot(findOwned(tx, userId, id), rows.length),
      ...(changes && { lines: changes.after }),
    },
  });
  return { id, revision: 1, totals };
}

export function saveDraft(
  actor: Actor,
  raw: DraftInput,
  auditNote: Record<string, unknown> = {},
): SavedDraft {
  const userId = ownerOf(actor);
  const input = parseDraft(raw);
  const { id: existingId, clientId, revision, lines, ...fields } = input;
  const totals = totalsOf(lines, fields);
  const rows = lineRows(lines, totals);

  return unlessUnchanged(() =>
    mutate(actor, "invoice.save", (tx, audit) => {
      const before = existingId
        ? findOwned(tx, userId, existingId)
        : clientId
          ? draftWithClientId(tx, userId, clientId)
          : null;
      if (!before) return createDraftIn(tx, audit, userId, input, undefined, auditNote);
      if (before.status !== "draft") throw new ServiceError(TEXTS.invoices.stale);
      assertDraftIdentity(before, fields);
      assertReferencesOwned(tx, userId, input);

      const customerName = customerNameOf(tx, userId, fields.customerId);
      const values = {
        ...fields,
        ...normalizedRate(fields, before, fields.exchangeRateSource),
        ...sumsOf(totals),
        customerName,
      };
      const beforeLines = linesOf(tx, userId, before.id);
      if (
        matches(before, values) &&
        beforeLines.length === rows.length &&
        rows.every((row, i) => matches(beforeLines[i]!, row))
      ) {
        throw new Unchanged({
          id: before.id,
          revision: before.revision,
          totals,
        });
      }
      // Checked after the comparison: a retry of a write whose reply got lost changes nothing.
      if (before.revision !== revision) throw new ServiceError(TEXTS.invoices.stale);

      const { id } = before;
      const nextRevision = before.revision + 1;
      tx.update(invoice)
        .set({
          ...values,
          searchText: searchTextOf({ customerName, lines: rows }),
          revision: nextRevision,
          updatedAt: clock.now(),
        })
        .where(and(eq(invoice.id, id), eq(invoice.userId, userId)))
        .run();
      tx.delete(invoiceLine)
        .where(scoped(userId).where(invoiceLine, (t, { eq }) => eq(t.invoiceId, id)))
        .run();
      insertLines(tx, userId, id, rows);
      const changes = diffLines(beforeLines, rows);
      audit({
        entity: "invoice",
        entityId: id,
        ownerId: userId,
        scope: "user",
        before: {
          ...auditSnapshot(before, beforeLines.length),
          ...(changes && { lines: changes.before }),
        },
        after: {
          ...auditNote,
          ...auditSnapshot(findOwned(tx, userId, id), rows.length),
          ...(changes && { lines: changes.after }),
        },
      });
      return { id, revision: nextRevision, totals };
    }),
  );
}

export function deleteDraft(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "invoice.delete", (tx, audit) => {
    const row = findOwned(tx, userId, id);
    if (row.status !== "draft") throw new ServiceError(V.notDraft);
    const lines = linesOf(tx, userId, id);
    tx.delete(invoice)
      .where(and(eq(invoice.id, id), eq(invoice.userId, userId)))
      .run();
    audit({
      entity: "invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: {
        ...auditSnapshot(row, lines.length),
        lines: lines.map(lineBody),
      },
    });
  });
}

export function accountForCopy(tx: Tx, ownerId: string, source: Invoice): string | null {
  if (!source.bankAccountId) return null;
  const account = tx
    .select({ hidden: bankAccount.hidden })
    .from(bankAccount)
    .where(scoped(ownerId).where(bankAccount, (t, { eq }) => eq(t.id, source.bankAccountId!)))
    .get();
  if (!account?.hidden) return source.bankAccountId;
  return defaultAccountFor(ownerId, source.currency)?.id ?? null;
}

export function duplicateInvoice(actor: Actor, id: string): { id: string } {
  const userId = ownerOf(actor);
  return mutate(actor, "invoice.duplicate", (tx, audit) => {
    const source = findOwned(tx, userId, id);
    if (source.type === "credit_note") throw new ServiceError(V.creditNoteCopy);
    const lines = linesOf(tx, userId, id);
    const totals = totalsOf(lines, source);
    const copyId = randomUUID();
    const today = calendarDateInPrague(clock.now());
    const now = clock.now();
    const dueDate =
      source.issueDate && source.dueDate
        ? addDays(today, Math.max(0, daysBetween(source.issueDate, source.dueDate)))
        : null;

    tx.insert(invoice)
      .values({
        id: copyId,
        userId,
        type: source.type,
        seriesId: source.seriesId,
        customerId: source.customerId,
        customerName: source.customerName,
        bankAccountId: accountForCopy(tx, userId, source),
        issueDate: today,
        dueDate,
        taxableDate: source.taxableDate ? today : null,
        language: source.language,
        currency: source.currency,
        exchangeRateMicros: null,
        foreign: source.foreign,
        clause: source.clause,
        paymentMethod: source.paymentMethod,
        orderRef: source.orderRef,
        reference: source.reference,
        textBefore: source.textBefore,
        textAfter: source.textAfter,
        note: source.note,
        discountKind: source.discountKind,
        discountValue: source.discountValue,
        rounding: source.rounding,
        ...sumsOf(totals),
        appearance: source.appearance,
        searchText: searchTextOf({ customerName: source.customerName, lines }),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertLines(
      tx,
      userId,
      copyId,
      lines.map(({ id: _i, invoiceId: _v, userId: _u, ...line }) => line),
    );
    linkTags(
      tx,
      userId,
      copyId,
      tagsOf(tx, userId, id).map((row) => row.id),
    );
    audit({
      entity: "invoice",
      entityId: copyId,
      ownerId: userId,
      scope: "user",
      after: {
        duplicatedFrom: id,
        ...auditSnapshot(findOwned(tx, userId, copyId), lines.length),
        lines: lines.map(lineBody),
      },
    });
    return { id: copyId };
  });
}

export const INVOICE_SORTS = [
  "number",
  "customer",
  "issueDate",
  "dueDate",
  "total",
  "status",
] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];
export type SortDirection = "asc" | "desc";
export type InvoiceStatusFilter = InvoiceStatus | "overdue";

export type InvoiceFilter = {
  q?: string;
  status?: InvoiceStatusFilter;
  customerId?: string;
  from?: string;
  to?: string;
  currency?: Currency;
  type?: InvoiceType;
  tagId?: string;
  external?: boolean;
  sort?: InvoiceSort;
  dir?: SortDirection;
  page?: number;
  pageSize?: number;
};

export type InvoiceRow = {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  customerId: string | null;
  customerName: string;
  issueDate: string | null;
  dueDate: string | null;
  currency: Currency;
  type: InvoiceType;
  totalMinor: number;
  paidMinor: number;
  creditsMinor: number;
  advanceMinor: number;
  supersededAt: Date | null;
  overdue: boolean;
};

export type InvoiceSummaryRow = {
  currency: Currency;
  invoicedMinor: number;
  paidMinor: number;
  overdueMinor: number;
  advanceOpenMinor: number;
};

export type SortLink = { href: string; active: SortDirection | null };
export type InvoiceFilterOptions = { customers: { id: string; name: string }[]; tags: Tag[] };

export const INVOICE_STATUS_PARAM: Record<InvoiceStatusFilter, string> = {
  draft: "koncept",
  issued: "vystavena",
  sent: "odeslana",
  partially_paid: "castecne-uhrazena",
  paid: "uhrazena",
  cancelled: "stornovana",
  credited: "dobropisovana",
  overdue: "po-splatnosti",
};
export const INVOICE_STATUS_FILTERS = [...INVOICE_STATUSES, "overdue"] as const;

const SORT_PARAM: Record<InvoiceSort, string> = {
  number: "cislo",
  customer: "zakaznik",
  issueDate: "vystaveno",
  dueDate: "splatnost",
  total: "castka",
  status: "stav",
};

const LIST_PAGE_SIZE = 25;
const MAX_LIST_PAGE_SIZE = 100;
const MAX_QUERY_CHARS = 100;
const MAX_ID_CHARS = 100;
const CUSTOMER_CARD_ROWS = 10;
// Credited stays in: without it +1000 and its -1000 credit note would not net out.
const NOT_IN_TOTALS = ["draft", "cancelled"] as const satisfies InvoiceStatus[];

function keyOf<K extends string>(map: Record<K, string>, value: string | undefined): K | undefined {
  return (Object.keys(map) as K[]).find((key) => map[key] === value);
}

export function parseInvoiceFilter(
  raw: Record<string, string | string[] | undefined>,
): InvoiceFilter {
  const one = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const date = (key: string) => {
    const value = one(key);
    return value && isCalendarDate(value) ? value : undefined;
  };
  const id = (key: string) => one(key)?.slice(0, MAX_ID_CHARS) || undefined;
  const page = Number(one("strana"));
  const dir = one("smer");
  const entries = {
    q: one("q")?.trim().slice(0, MAX_QUERY_CHARS) || undefined,
    status: keyOf(INVOICE_STATUS_PARAM, one("stav")),
    customerId: id("zakaznik"),
    from: date("od"),
    to: date("do"),
    currency: CURRENCIES.find((currency) => currency === one("mena")),
    type: INVOICE_TYPES.find((type) => type === one("typ")),
    tagId: id("stitek"),
    external: one("jinde") === "1" ? true : undefined,
    sort: keyOf(SORT_PARAM, one("razeni")),
    dir: dir === "asc" || dir === "desc" ? dir : undefined,
    page: Number.isInteger(page) && page > 1 && page <= 100_000 ? page : undefined,
  };
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as InvoiceFilter;
}

function sortOf(filter: InvoiceFilter): { sort: InvoiceSort; dir: SortDirection } {
  return {
    sort: filter.sort ?? "issueDate",
    dir: filter.dir ?? (filter.sort ? "asc" : "desc"),
  };
}

export function invoiceSortParams(filter: InvoiceFilter): Record<string, string> {
  return {
    ...(filter.sort && { razeni: SORT_PARAM[filter.sort] }),
    ...(filter.dir && { smer: filter.dir }),
  };
}

export function invoiceQuery(filter: InvoiceFilter): string {
  const params = new URLSearchParams({
    ...(filter.q && { q: filter.q }),
    ...(filter.status && { stav: INVOICE_STATUS_PARAM[filter.status] }),
    ...(filter.customerId && { zakaznik: filter.customerId }),
    ...(filter.from && { od: filter.from }),
    ...(filter.to && { do: filter.to }),
    ...(filter.currency && { mena: filter.currency }),
    ...(filter.type && { typ: filter.type }),
    ...(filter.tagId && { stitek: filter.tagId }),
    ...(filter.external && { jinde: "1" }),
    ...invoiceSortParams(filter),
    ...(filter.page && filter.page > 1 && { strana: String(filter.page) }),
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function invoiceSortLinks(filter: InvoiceFilter): Record<InvoiceSort, SortLink> {
  const current = sortOf(filter);
  const link = (sort: InvoiceSort): SortLink => {
    const active = current.sort === sort ? current.dir : null;
    const { page: _p, ...rest } = filter;
    const dir = active === "asc" ? "desc" : "asc";
    return { href: `/faktury${invoiceQuery({ ...rest, sort, dir })}`, active };
  };
  return Object.fromEntries(INVOICE_SORTS.map((sort) => [sort, link(sort)])) as Record<
    InvoiceSort,
    SortLink
  >;
}

export function isFiltered(filter: InvoiceFilter): boolean {
  const { sort: _s, dir: _d, page: _p, pageSize: _z, ...rest } = filter;
  return Object.keys(rest).length > 0;
}

const fullDue = sql`${invoice.totalMinor} + ${invoice.creditsMinor} - ${invoice.advanceMinor} - ${invoice.paidMinor}`;

// The SQL form of amountDue in lib/qr-payload.
export const dueSql: SQL<number> = sql<number>`CASE WHEN ${invoice.supersededAt} IS NULL THEN ${fullDue} ELSE min(0, ${fullDue}) END`;

// A zero document keeps a stranded payment as awaiting, and that must not lower what is owed.
const openCondition = and(inArray(invoice.status, AWAITING_PAYMENT), gt(dueSql, 0));

const invoicedSql = sql<number>`coalesce(sum(CASE WHEN ${invoice.type} <> 'advance' THEN ${invoice.totalMinor} ELSE 0 END), 0)`;

// The SQL form of isOverdue in lib/invoice; tests compare the two.
function overdueCondition(today: string): SQL {
  return and(
    inArray(invoice.status, AWAITING_PAYMENT),
    gt(dueSql, 0),
    lt(invoice.dueDate, today),
  ) as SQL;
}

function statusCondition(status: InvoiceStatusFilter): SQL {
  return status === "overdue"
    ? overdueCondition(calendarDateInPrague(clock.now()))
    : eq(invoice.status, status);
}

function ownedCustomerId(ownerId: string, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return db
    .select({ id: customer.id })
    .from(customer)
    .where(scoped(ownerId).where(customer, (t, { eq }) => eq(t.id, id)))
    .get()?.id;
}

function invoiceConditions(ownerId: string, filter: InvoiceFilter): SQL {
  const customerId = ownedCustomerId(ownerId, filter.customerId);
  const tagId = listTags(ownerId).find((tag) => tag.id === filter.tagId)?.id;
  return scoped(ownerId).where(invoice, (t, { and, eq }) =>
    and(
      filter.q
        ? sql`${t.searchText} LIKE ${`%${escapeLike(foldText(filter.q))}%`} ESCAPE '\\'`
        : undefined,
      filter.status ? statusCondition(filter.status) : undefined,
      customerId ? eq(t.customerId, customerId) : undefined,
      filter.from ? gte(t.issueDate, filter.from) : undefined,
      filter.to ? lte(t.issueDate, filter.to) : undefined,
      filter.currency ? eq(t.currency, filter.currency) : undefined,
      filter.type ? eq(t.type, filter.type) : undefined,
      filter.external ? eq(t.external, true) : undefined,
      tagId
        ? exists(
            db
              .select({ id: invoiceTag.invoiceId })
              .from(invoiceTag)
              .where(and(eq(invoiceTag.invoiceId, t.id), eq(invoiceTag.tagId, tagId))),
          )
        : undefined,
    ),
  );
}

const STATUS_RANK = sql`CASE ${invoice.status} ${sql.raw(
  INVOICE_STATUSES.map((status, rank) => `WHEN '${status}' THEN ${rank}`).join(" "),
)} END`;

const SORT_COLUMNS = {
  number: czech(invoice.number),
  customer: czech(invoice.customerName),
  issueDate: invoice.issueDate,
  dueDate: invoice.dueDate,
  total: invoice.totalMinor,
  status: STATUS_RANK,
} satisfies Record<InvoiceSort, unknown>;

function invoiceRows(where: SQL, filter: InvoiceFilter): Page<InvoiceRow> {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const pageSize = Math.min(MAX_LIST_PAGE_SIZE, Math.max(1, filter.pageSize ?? LIST_PAGE_SIZE));
  const { sort, dir } = sortOf(filter);
  const rows = db
    .select({
      id: invoice.id,
      status: invoice.status,
      number: invoice.number,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      type: invoice.type,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      creditsMinor: invoice.creditsMinor,
      advanceMinor: invoice.advanceMinor,
      supersededAt: invoice.supersededAt,
    })
    .from(invoice)
    .where(where)
    .orderBy((dir === "asc" ? asc : desc)(SORT_COLUMNS[sort]), asc(invoice.id))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize)
    .all();
  const today = calendarDateInPrague(clock.now());
  return {
    rows: rows.slice(0, pageSize).map((row) => ({ ...row, overdue: isOverdue(row, today) })),
    page,
    pageSize,
    hasNext: rows.length > pageSize,
  };
}

export function listInvoices(ownerId: string, filter: InvoiceFilter): Page<InvoiceRow> {
  return invoiceRows(invoiceConditions(ownerId, filter), filter);
}

export function invoiceSummary(ownerId: string, filter: InvoiceFilter): InvoiceSummaryRow[] {
  const overdue = and(
    overdueCondition(calendarDateInPrague(clock.now())),
    ne(invoice.type, "advance"),
  );
  const advanceOpen = and(openCondition, eq(invoice.type, "advance"));
  return db
    .select({
      currency: invoice.currency,
      invoicedMinor: invoicedSql,
      paidMinor: sql<number>`coalesce(sum(${invoice.paidMinor}), 0)`,
      overdueMinor: sql<number>`coalesce(sum(CASE WHEN ${overdue} THEN ${dueSql} ELSE 0 END), 0)`,
      advanceOpenMinor: sql<number>`coalesce(sum(CASE WHEN ${advanceOpen} THEN ${dueSql} ELSE 0 END), 0)`,
    })
    .from(invoice)
    .where(and(invoiceConditions(ownerId, filter), notInArray(invoice.status, NOT_IN_TOTALS)))
    .groupBy(invoice.currency)
    .orderBy(asc(invoice.currency))
    .all();
}

export function customerInvoiceStats(ownerId: string, customerId: string) {
  const ofCustomer = scoped(ownerId).where(invoice, (t, { eq }) => eq(t.customerId, customerId));
  const outstanding = and(openCondition, ne(invoice.type, "advance"));
  const advanceOpen = and(openCondition, eq(invoice.type, "advance"));
  const sums = db
    .select({
      currency: invoice.currency,
      invoicedMinor: invoicedSql,
      paidMinor: sql<number>`coalesce(sum(${invoice.paidMinor}), 0)`,
      outstandingMinor: sql<number>`coalesce(sum(CASE WHEN ${outstanding} THEN ${dueSql} ELSE 0 END), 0)`,
      advanceOpenMinor: sql<number>`coalesce(sum(CASE WHEN ${advanceOpen} THEN ${dueSql} ELSE 0 END), 0)`,
    })
    .from(invoice)
    .where(and(ofCustomer, notInArray(invoice.status, NOT_IN_TOTALS)))
    .groupBy(invoice.currency)
    .orderBy(asc(invoice.currency))
    .all();
  const { rows, hasNext } = invoiceRows(ofCustomer, { pageSize: CUSTOMER_CARD_ROWS });
  return {
    sums,
    rows,
    hasMore: hasNext,
    averageDays: averagePaymentDays(ownerId, customerId),
  };
}

export function invoiceFilterOptions(ownerId: string): InvoiceFilterOptions {
  const customers = db
    .select({ id: customer.id, name: customer.name })
    .from(customer)
    .where(scoped(ownerId).where(customer))
    .orderBy(asc(czech(customer.name)), asc(customer.id))
    .all();
  return { customers, tags: listTags(ownerId) };
}
