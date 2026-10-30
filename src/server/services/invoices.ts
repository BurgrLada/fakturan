import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { foldText } from "@/lib/fold-text";
import { addDays, appearanceFrom, daysBetween, INVOICE_TYPES, toDiscount } from "@/lib/invoice";
import { diffLines, lineBody } from "@/lib/invoice-diff";
import {
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
  numberSeries,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { defaultAccountFor } from "./bank-accounts";
import { MAX_PRICE_MINOR } from "./catalog";
import { customerDefaults } from "./customers";
import { mutate } from "./mutation";
import { defaultSeriesFor } from "./number-series";
import { colorSchema, designIdSchema, getPreferences, logoPositionSchema } from "./preferences";
import { linkTags, tagsOf, type Tag } from "./tags";

const V = TEXTS.invoices.validation;
const MAX_LINES = 500;
const MAX_EXCHANGE_RATE_MICROS = 1_000_000_000_000;
const MAX_NUMBER = 100;
export const MAX_LINE_NAME = 200;
export const MAX_DOCUMENT_TEXT = 2000;

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

function checkDiscount(
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

function withoutStrayDiscount<T extends { discountKind: DiscountKind; discountValue: number }>(
  value: T,
): T {
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
    unitPriceMinor: z.number(V.price).int(V.price).min(0, V.price).max(MAX_PRICE_MINOR, V.price),
    ...discountFields,
  })
  .superRefine(checkDiscount)
  .transform(withoutStrayDiscount);

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

const documentFields = {
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
  paymentMethod: z.enum(PAYMENT_METHODS, V.paymentMethod),
  orderRef: text(200),
  reference: text(200),
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
    revision: z.number(V.invalid).int(V.invalid).optional(),
    type: z.enum(INVOICE_TYPES, V.type),
    customerId: reference,
    seriesId: reference,
    ...documentFields,
  })
  .superRefine(checkDiscount)
  .transform(withoutStrayDiscount);

// Type, customer and series are absent on purpose: the customer changes only through
// refreshCustomerSnapshot (CUS-008). A missing revision is reported as stale by the service.
export const issuedInputSchema = z
  .object({
    revision: z.number(V.invalid).int(V.invalid).nullish(),
    number: z.string(V.number).trim().min(1, V.number).max(MAX_NUMBER, V.number),
    ...documentFields,
  })
  .superRefine(checkDiscount)
  .transform(withoutStrayDiscount);

export type DraftInput = z.input<typeof draftInputSchema>;
export type IssuedInput = z.input<typeof issuedInputSchema>;
type Draft = z.output<typeof draftInputSchema>;
type DraftLine = Draft["lines"][number];

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

export function newDraftDefaults(ownerId: string, customerId: string | null): DraftInput {
  const prefs = getPreferences(ownerId);
  const defaults = customerId ? customerDefaults(ownerId, customerId, prefs) : prefs;
  const issueDate = defaultIssueDate(defaults.issueDateMode, clock.now());
  return {
    type: "invoice",
    customerId,
    bankAccountId: defaultAccountFor(ownerId, defaults.currency)?.id ?? null,
    seriesId: defaultSeriesFor(ownerId, "invoice")?.id ?? null,
    issueDate,
    dueDate: addDays(issueDate, defaults.dueDays),
    taxableDate: null,
    language: defaults.language,
    currency: defaults.currency,
    exchangeRateMicros: null,
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
  draft: Pick<Draft, "discountKind" | "discountValue" | "rounding">,
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
  draft: Pick<Draft, "customerId" | "bankAccountId" | "seriesId" | "lines">,
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

export function saveDraft(actor: Actor, raw: DraftInput): SavedDraft {
  const userId = ownerOf(actor);
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  const { id: existingId, revision, lines, ...fields } = parsed.data;
  const totals = totalsOf(lines, fields);
  const rows = lineRows(lines, totals);

  return unlessUnchanged(() =>
    mutate(actor, "invoice.save", (tx, audit) => {
      const before = existingId ? findOwned(tx, userId, existingId) : null;
      if (before && (before.status !== "draft" || before.revision !== revision)) {
        throw new ServiceError(TEXTS.invoices.stale);
      }
      assertReferencesOwned(tx, userId, parsed.data);

      const customerName = customerNameOf(tx, userId, fields.customerId);
      const values = { ...fields, ...sumsOf(totals), customerName };
      const beforeLines = before ? linesOf(tx, userId, before.id) : [];
      if (
        before &&
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

      const id = before?.id ?? randomUUID();
      const nextRevision = (before?.revision ?? 0) + 1;
      const searchText = searchTextOf({ customerName, lines: rows });
      const now = clock.now();
      if (before) {
        tx.update(invoice)
          .set({
            ...values,
            searchText,
            revision: nextRevision,
            updatedAt: now,
          })
          .where(and(eq(invoice.id, id), eq(invoice.userId, userId)))
          .run();
        tx.delete(invoiceLine)
          .where(scoped(userId).where(invoiceLine, (t, { eq }) => eq(t.invoiceId, id)))
          .run();
      } else {
        tx.insert(invoice)
          .values({
            id,
            userId,
            ...values,
            searchText,
            revision: nextRevision,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      insertLines(tx, userId, id, rows);
      const changes = diffLines(beforeLines, rows);
      audit({
        entity: "invoice",
        entityId: id,
        ownerId: userId,
        scope: "user",
        before: before && {
          ...auditSnapshot(before, beforeLines.length),
          ...(changes && { lines: changes.before }),
        },
        after: {
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

function accountForCopy(tx: Tx, ownerId: string, source: Invoice): string | null {
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
