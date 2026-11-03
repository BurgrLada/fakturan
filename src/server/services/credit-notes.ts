import "server-only";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { isCreditable } from "@/lib/invoice";
import { lineBody } from "@/lib/invoice-diff";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { invoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { creditsOf } from "./invoice-balance";
import {
  assertNotExternal,
  auditSnapshot,
  findOwned,
  insertLines,
  lineRows,
  linesOf,
  ownerOf,
  searchTextOf,
  sumsOf,
  totalsOf,
  type Invoice,
} from "./invoices";
import { mutate } from "./mutation";
import { defaultSeriesFor } from "./number-series";
import { hasDifference } from "./payments";

const V = TEXTS.invoices.validation;

type NoteCheck = Pick<Invoice, "id" | "relatedInvoiceId" | "totalMinor">;

export function creditableMinor(
  q: Reader,
  ownerId: string,
  invoiceId: string,
  exceptNoteId?: string,
): number {
  const { totalMinor } = findOwned(q, ownerId, invoiceId);
  return totalMinor + creditsOf(q, ownerId, invoiceId, exceptNoteId);
}

export function creditLimitProblem(q: Reader, ownerId: string, note: NoteCheck): string | null {
  if (note.totalMinor >= 0) return V.creditNotNegative;
  if (!note.relatedInvoiceId) return V.notCreditable;
  const left = creditableMinor(q, ownerId, note.relatedInvoiceId, note.id);
  return left + note.totalMinor < 0 ? V.creditExceeds : null;
}

// For a note about to count against the original, which may have moved on since the draft.
export function creditNoteProblem(
  q: Reader,
  ownerId: string,
  note: NoteCheck & Pick<Invoice, "currency" | "exchangeRateMicros">,
): string | null {
  if (!note.relatedInvoiceId) return V.notCreditable;
  const original = findOwned(q, ownerId, note.relatedInvoiceId);
  if (!isCreditable(original)) return V.notCreditable;
  // The difference was computed from the old balance, a correction would leave it wrong.
  if (hasDifference(q, ownerId, [original.id])) return V.creditDifference;
  const sameMoney =
    original.currency === note.currency && original.exchangeRateMicros === note.exchangeRateMicros;
  return sameMoney ? creditLimitProblem(q, ownerId, note) : V.currencyHasCredits;
}

export function createCreditNote(actor: Actor, invoiceId: string): { id: string } {
  const userId = ownerOf(actor);
  return mutate(actor, "invoice.credit_note", (tx, audit) => {
    const source = findOwned(tx, userId, invoiceId);
    assertNotExternal(source);
    const exhausted = creditableMinor(tx, userId, invoiceId) <= 0;
    if (!isCreditable(source) || exhausted) throw new ServiceError(V.notCreditable);
    // 0 - price, not -price: a free line would become -0. The catalog link stays behind, because
    // a correction is not another use of the item.
    const lines = linesOf(tx, userId, invoiceId).map(
      ({
        name,
        description,
        quantityMilli,
        unit,
        unitPriceMinor,
        discountKind,
        discountValue,
      }) => ({
        catalogItemId: null,
        name,
        description,
        quantityMilli,
        unit,
        unitPriceMinor: 0 - unitPriceMinor,
        discountKind,
        discountValue,
      }),
    );
    const totals = totalsOf(lines, source);
    const rows = lineRows(lines, totals);
    const id = randomUUID();
    const today = calendarDateInPrague(clock.now());
    const now = clock.now();
    tx.insert(invoice)
      .values({
        id,
        userId,
        type: "credit_note",
        relatedInvoiceId: invoiceId,
        seriesId: defaultSeriesFor(userId, "credit_note")?.id ?? null,
        customerId: source.customerId,
        customerName: source.customerName,
        bankAccountId: source.bankAccountId,
        issueDate: today,
        dueDate: today,
        taxableDate: source.taxableDate ? today : null,
        language: source.language,
        currency: source.currency,
        exchangeRateMicros: source.exchangeRateMicros,
        exchangeRateSource: source.exchangeRateSource,
        exchangeRateDate: source.exchangeRateDate,
        foreign: source.foreign,
        clause: source.clause,
        paymentMethod: source.paymentMethod,
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
    insertLines(tx, userId, id, rows);
    audit({
      entity: "invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      after: {
        ...auditSnapshot(findOwned(tx, userId, id), rows.length),
        lines: rows.map(lineBody),
      },
    });
    return { id };
  });
}

const RELATED_COLUMNS = {
  id: invoice.id,
  type: invoice.type,
  status: invoice.status,
  number: invoice.number,
  totalMinor: invoice.totalMinor,
  currency: invoice.currency,
};

export function relatedDocuments(ownerId: string, id: string) {
  const { relatedInvoiceId } = findOwned(db, ownerId, id);
  const parent = relatedInvoiceId
    ? (db
        .select(RELATED_COLUMNS)
        .from(invoice)
        .where(scoped(ownerId).where(invoice, (t) => eq(t.id, relatedInvoiceId)))
        .get() ?? null)
    : null;
  const children = db
    .select(RELATED_COLUMNS)
    .from(invoice)
    .where(scoped(ownerId).where(invoice, (t) => eq(t.relatedInvoiceId, id)))
    .orderBy(asc(invoice.createdAt), asc(invoice.id))
    .all();
  return { parent, children };
}

export type RelatedDocument = ReturnType<typeof relatedDocuments>["children"][number];
