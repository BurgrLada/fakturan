import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { isActiveDocument, type InvoiceStatus, type InvoiceType } from "@/lib/invoice";
import { diffLines } from "@/lib/invoice-diff";
import { discountNotes } from "@/lib/invoice-form";
import { deviationExceeds, rateDate } from "@/lib/fx";
import { allowsNegativePrice } from "@/lib/invoice-totals";
import { calendarDateInPrague, variableSymbolFrom } from "@/lib/number-format";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import type { AuditAction } from "../audit/record";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { bankAccount, catalogItem, invoice, invoiceLine, numberSeries } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { recordCatalogUse } from "./catalog";
import { creditNoteProblem } from "./credit-notes";
import { resolveRate } from "./exchange-rates";
import { hasPayments, refreshBalance } from "./invoice-balance";
import {
  currentParties,
  relatedSnapshotOf,
  renderDocumentTexts,
  variablesFor,
} from "./invoice-document";
import {
  auditSnapshot,
  findOwned,
  linesOf,
  MANUAL_VARIABLE_SYMBOL,
  MAX_DOCUMENT_TEXT,
  MAX_LINE_NAME,
  MAX_REFERENCE,
  ownerOf,
  searchTextOf,
  sumsOf,
  totalsOf,
  type Invoice,
  type InvoiceLine,
} from "./invoices";
import { mutate, type Audit } from "./mutation";
import { allocateNumber, defaultSeriesFor, peekNumber, type NumberSeries } from "./number-series";
import { getPreferences } from "./preferences";
import { missingSupplierKeys } from "./supplier";

const V = TEXTS.invoices.validation;
const T = TEXTS.invoices.issue;

export type IssueProblem = { field: string; message: string };

export class NotIssuableError extends ServiceError {
  readonly problems: IssueProblem[];

  constructor(problems: IssueProblem[]) {
    super(problems.map((problem) => problem.message).join("; "));
    this.problems = problems;
  }
}

function pickSeries(
  q: Reader,
  ownerId: string,
  row: Invoice,
  chosenId: string | null,
): { series: NumberSeries } | { problem: IssueProblem } {
  const problem = (message: string) => ({
    problem: { field: "seriesId", message },
  });
  if (!chosenId) {
    const series = defaultSeriesFor(ownerId, row.type);
    return series ? { series } : problem(T.noSeries);
  }
  const series = q
    .select()
    .from(numberSeries)
    .where(scoped(ownerId).where(numberSeries, (t, { eq }) => eq(t.id, chosenId)))
    .get();
  if (!series) return problem(V.seriesNotFound);
  return series.documentType === row.type ? { series } : problem(T.seriesType);
}

function supplierProblems(ownerId: string): IssueProblem[] {
  return missingSupplierKeys(ownerId).map((key) => ({
    field: `supplier.${key}`,
    message: T.supplier(TEXTS.supplier.required[key]),
  }));
}

// The statement is printed in the document's language from the document's own supplier, so an
// issued document is judged by its snapshot: changing the settings cannot fix it afterwards.
export function vatStatementProblems(q: Reader, ownerId: string, row: Invoice): IssueProblem[] {
  const frozen = row.supplierSnapshot;
  const profile = frozen ?? currentParties(q, ownerId, row).snapshot.supplier;
  if (!profile) return [];
  const key = row.language === "en" ? "notVatPayerEn" : "notVatPayerCs";
  if (profile[key].trim()) return [];
  const label = TEXTS.supplier.fields[key];
  return [
    {
      field: `supplier.${key}`,
      message: frozen ? T.notVatPayerFrozen(label) : T.notVatPayer(label),
    },
  ];
}

type CheckedLine = Pick<
  InvoiceLine,
  "name" | "quantityMilli" | "unitPriceMinor" | "discountKind" | "discountValue"
>;

function lineProblems(lines: CheckedLine[], type: InvoiceType): IssueProblem[] {
  if (lines.length === 0) return [{ field: "lines", message: T.noLines }];
  return lines.flatMap((line, i) => {
    const position = i + 1;
    const found: IssueProblem[] = [];
    if (!line.name.trim()) {
      found.push({ field: `lines.${i}.name`, message: T.lineName(position) });
    }
    if (line.quantityMilli <= 0) {
      found.push({
        field: `lines.${i}.quantityMilli`,
        message: T.lineQuantity(position),
      });
    }
    if (line.unitPriceMinor < 0 && !allowsNegativePrice(type)) {
      found.push({
        field: `lines.${i}.unitPriceMinor`,
        message: T.linePrice(position),
      });
    }
    return found;
  });
}

function amountProblems(row: Invoice, lines: CheckedLine[]): IssueProblem[] {
  try {
    totalsOf(lines, row);
    return [];
  } catch (error) {
    if (error instanceof ServiceError) return [{ field: "lines", message: error.message }];
    throw error;
  }
}

function dateProblems(row: Invoice): IssueProblem[] {
  const found: IssueProblem[] = [];
  if (!row.issueDate) found.push({ field: "issueDate", message: T.issueDate });
  if (!row.dueDate) found.push({ field: "dueDate", message: T.dueDate });
  if (row.issueDate && row.dueDate && row.dueDate < row.issueDate) {
    found.push({ field: "dueDate", message: T.dueBeforeIssue });
  }
  return found;
}

// A set account prints on the document whatever the payment method, so it is checked always.
// keptAccountId is already on the document, so hiding it later does not block other edits.
function accountProblems(
  q: Reader,
  ownerId: string,
  row: Invoice,
  keptAccountId: string | null,
): IssueProblem[] {
  const problem = (message: string) => [{ field: "bankAccountId", message }];
  const { bankAccountId } = row;
  if (!bankAccountId) {
    return row.paymentMethod === "transfer" ? problem(T.noAccount(row.currency)) : [];
  }
  const account = q
    .select({ currency: bankAccount.currency, hidden: bankAccount.hidden })
    .from(bankAccount)
    .where(scoped(ownerId).where(bankAccount, (t, { eq }) => eq(t.id, bankAccountId)))
    .get();
  if (!account) return problem(V.accountNotFound);
  if (account.hidden && bankAccountId !== keptAccountId) return problem(T.accountHidden);
  return account.currency === row.currency ? [] : problem(T.accountCurrency(row.currency));
}

// The supplier's required fields are frozen in the snapshot, so only issuing checks those.
export function documentProblems(
  q: Reader,
  ownerId: string,
  row: Invoice,
  lines: CheckedLine[],
  keptAccountId: string | null = null,
): IssueProblem[] {
  const ofLines = lineProblems(lines, row.type);
  const found = [
    ...(row.customerId ? [] : [{ field: "customerId", message: T.customer }]),
    ...ofLines,
    ...(ofLines.length === 0 ? amountProblems(row, lines) : []),
    ...dateProblems(row),
    ...accountProblems(q, ownerId, row, keptAccountId),
    ...vatStatementProblems(q, ownerId, row),
  ];
  if (row.currency !== "CZK" && !row.exchangeRateMicros) {
    found.push({
      field: "exchangeRateMicros",
      message: T.exchangeRate(row.currency),
    });
  }
  return found;
}

// A credit note repeats the account of the original, so hiding that account must not block it.
function creditProblems(q: Reader, ownerId: string, row: Invoice): IssueProblem[] {
  if (row.type !== "credit_note") return [];
  const message = creditNoteProblem(q, ownerId, row);
  return message ? [{ field: "lines", message }] : [];
}

function keptAccountOf(q: Reader, ownerId: string, row: Invoice): string | null {
  if (row.type !== "credit_note" || !row.relatedInvoiceId) return null;
  return findOwned(q, ownerId, row.relatedInvoiceId).bankAccountId;
}

function draftProblems(q: Reader, ownerId: string, row: Invoice, lines: InvoiceLine[]) {
  return [
    ...supplierProblems(ownerId),
    ...documentProblems(q, ownerId, row, lines, keptAccountOf(q, ownerId, row)),
    ...creditProblems(q, ownerId, row),
  ];
}

export function checkIssuable(ownerId: string, id: string): IssueProblem[] {
  const stored = findOwned(db, ownerId, id);
  if (stored.status !== "draft") return [{ field: "status", message: T.alreadyIssued }];
  const row = ratedFor(db, ownerId, stored);
  const lines = linesOf(db, ownerId, id);
  const found = draftProblems(db, ownerId, row, lines);
  const picked = pickSeries(db, ownerId, row, row.seriesId);
  if ("problem" in picked) found.push(picked.problem);
  const number =
    "series" in picked && row.issueDate
      ? peekNumber(db, ownerId, picked.series, row.issueDate)
      : "";
  return [...found, ...textProblems(issuedTexts(db, ownerId, row, lines, number))];
}

type RateFields = Pick<Invoice, "exchangeRateMicros" | "exchangeRateSource" | "exchangeRateDate">;

// A rate typed by a person is never replaced. Older documents carry a rate without a source and
// count as typed. Otherwise the rate follows the decisive day, which the issue dialog may have changed.
function ratedFor(q: Reader, ownerId: string, row: Invoice): Invoice {
  const typed = row.exchangeRateSource === "manual" || row.exchangeRateSource === null;
  if (row.currency === "CZK" || row.type === "credit_note") return row;
  if (typed && row.exchangeRateMicros !== null) return row;
  const day = rateDate(row, getPreferences(ownerId).fxBasis, calendarDateInPrague(clock.now()));
  const found = resolveRate(q, ownerId, row.currency, day, clock.now());
  if (!found) return row;
  const fields: RateFields = {
    exchangeRateMicros: found.rateMicros,
    exchangeRateSource: found.source,
    exchangeRateDate: found.listDate,
  };
  return { ...row, ...fields };
}

function rateNotes(q: Reader, ownerId: string, row: Invoice): string[] {
  if (row.currency === "CZK" || !row.exchangeRateMicros) return [];
  const R = TEXTS.exchangeRates.notes;
  const format = getPreferences(ownerId).dateFormat;
  const day = rateDate(row, getPreferences(ownerId).fxBasis, calendarDateInPrague(clock.now()));
  const listed = resolveRate(q, ownerId, row.currency, day, clock.now());
  const notes: string[] = [];
  if (row.exchangeRateSource === "last_known" && row.exchangeRateDate) {
    notes.push(R.lastKnown(row.currency, formatCalendarDate(row.exchangeRateDate, format)));
  }
  if (listed?.reference == null) notes.push(R.noReference);
  else if (deviationExceeds(row.exchangeRateMicros, listed.reference)) {
    notes.push(R.deviation(row.currency));
  }
  return notes;
}

export type IssuePreview = {
  problems: IssueProblem[];
  number: string | null;
  variableSymbol: string | null;
  issueDate: string | null;
  today: string;
  customerName: string;
  totalMinor: number;
  currency: Invoice["currency"];
  discountNotes: string[];
  rateNotes: string[];
  type: InvoiceType;
};

function capNotes(row: Invoice, lines: InvoiceLine[]): string[] {
  try {
    return discountNotes({ ...row, lines }, totalsOf(lines, row));
  } catch (error) {
    if (error instanceof ServiceError) return [];
    throw error;
  }
}

export function previewIssue(ownerId: string, id: string): IssuePreview {
  const row = ratedFor(db, ownerId, findOwned(db, ownerId, id));
  const picked = pickSeries(db, ownerId, row, row.seriesId);
  const number =
    "series" in picked && row.issueDate
      ? peekNumber(db, ownerId, picked.series, row.issueDate)
      : null;
  return {
    problems: checkIssuable(ownerId, id),
    number,
    variableSymbol: row.type === "credit_note" ? null : number && automaticSymbol(ownerId, number),
    issueDate: row.issueDate,
    today: calendarDateInPrague(clock.now()),
    customerName: currentParties(db, ownerId, row).snapshot.customer?.name ?? row.customerName,
    totalMinor: row.totalMinor,
    currency: row.currency,
    discountNotes: capNotes(row, linesOf(db, ownerId, id)),
    rateNotes: rateNotes(db, ownerId, row),
    type: row.type,
  };
}

// Variables can outgrow the limits saveDraft enforced, and editing an issued document validates
// against the same limits, so an oversized text would make the document uneditable.
function textProblems(texts: {
  orderRef: string;
  reference: string;
  textBefore: string;
  textAfter: string;
  note: string;
  lines: Pick<InvoiceLine, "name" | "description">[];
}): IssueProblem[] {
  const found: IssueProblem[] = [];
  for (const field of ["orderRef", "reference"] as const) {
    if (texts[field].length > MAX_REFERENCE) found.push({ field, message: T[field] });
  }
  for (const field of ["textBefore", "textAfter", "note"] as const) {
    if (texts[field].length > MAX_DOCUMENT_TEXT) found.push({ field, message: T[field] });
  }
  texts.lines.forEach((line, i) => {
    if (line.name.length > MAX_LINE_NAME) {
      found.push({ field: `lines.${i}.name`, message: T.lineNameLong(i + 1) });
    }
    if (line.description.length > MAX_DOCUMENT_TEXT) {
      found.push({
        field: `lines.${i}.description`,
        message: T.lineDescriptionLong(i + 1),
      });
    }
  });
  return found;
}

function issuedTexts(
  q: Reader,
  userId: string,
  row: Invoice,
  lines: InvoiceLine[],
  number: string,
) {
  const parties = currentParties(q, userId, row);
  const customerName = parties.snapshot.customer?.name ?? row.customerName;
  const ctx = variablesFor(userId, row, number, customerName);
  const texts = renderDocumentTexts(row, lines, ctx);
  return { ...texts, ...parties, customerName, dateFormat: ctx.dateFormat };
}

export function storeLines(
  tx: Tx,
  ownerId: string,
  before: InvoiceLine[],
  after: InvoiceLine[],
): void {
  after.forEach((line, i) => {
    const { name, description, netMinor } = line;
    const old = before[i]!;
    if (name === old.name && description === old.description && netMinor === old.netMinor) return;
    tx.update(invoiceLine)
      .set({ name, description, netMinor })
      .where(scoped(ownerId).where(invoiceLine, (t, { eq }) => eq(t.id, line.id)))
      .run();
  });
}

function catalogUses(tx: Tx, ownerId: string, lines: InvoiceLine[]) {
  const ids = [...new Set(lines.flatMap((line) => line.catalogItemId ?? []))];
  if (ids.length === 0) return [];
  return tx
    .select({ id: catalogItem.id, useCount: catalogItem.useCount })
    .from(catalogItem)
    .where(scoped(ownerId).where(catalogItem, (t) => inArray(t.id, ids)))
    .all();
}

export function automaticSymbol(ownerId: string, number: string): string | null {
  const format = getPreferences(ownerId).variableSymbolFormat;
  return (format === "digits" && variableSymbolFrom(number)) || null;
}

type IssueOptions = { revision: number; seriesId?: string; variableSymbol?: string };

export function issueIn(
  tx: Tx,
  audit: Audit,
  userId: string,
  id: string,
  opts: IssueOptions,
): { id: string; number: string } {
  const manualSymbol = opts.variableSymbol;
  if (manualSymbol !== undefined && !MANUAL_VARIABLE_SYMBOL.test(manualSymbol)) {
    throw new ServiceError(V.variableSymbol);
  }
  const stored = findOwned(tx, userId, id);
  if (stored.status !== "draft" || stored.revision !== opts.revision) {
    throw new ServiceError(TEXTS.invoices.stale);
  }
  const row = ratedFor(tx, userId, stored);
  const lines = linesOf(tx, userId, id);
  const picked = pickSeries(tx, userId, row, opts.seriesId ?? row.seriesId);
  const problems = draftProblems(tx, userId, row, lines);
  if ("problem" in picked) problems.push(picked.problem);
  if (problems.length > 0 || "problem" in picked) throw new NotIssuableError(problems);

  const totals = totalsOf(lines, row);
  const { number, skipped } = allocateNumber(tx, userId, picked.series.id, row.issueDate!);
  const texts = issuedTexts(tx, userId, row, lines, number);
  const overLimit = textProblems(texts);
  if (overLimit.length > 0) throw new NotIssuableError(overLimit);
  const issuedLines = texts.lines.map((line, i) => ({
    ...line,
    netMinor: totals.lines[i]!.netMinor,
  }));
  const now = clock.now();

  storeLines(tx, userId, lines, issuedLines);
  for (const line of lines) {
    if (line.catalogItemId) recordCatalogUse(tx, userId, line.catalogItemId);
  }
  const catalogUse = catalogUses(tx, userId, lines);
  const isNote = row.type === "credit_note";
  tx.update(invoice)
    .set({
      ...sumsOf(totals),
      ...texts.images,
      exchangeRateMicros: row.exchangeRateMicros,
      exchangeRateSource: row.exchangeRateSource,
      exchangeRateDate: row.exchangeRateDate,
      status: "issued",
      number,
      variableSymbol: isNote
        ? null
        : manualSymbol === undefined
          ? automaticSymbol(userId, number)
          : manualSymbol || null,
      variableSymbolManual: !isNote && manualSymbol !== undefined,
      relatedSnapshot: isNote ? relatedSnapshotOf(tx, userId, row) : row.relatedSnapshot,
      seriesId: picked.series.id,
      customerName: texts.customerName,
      dateFormat: texts.dateFormat,
      orderRef: texts.orderRef,
      reference: texts.reference,
      textBefore: texts.textBefore,
      textAfter: texts.textAfter,
      note: texts.note,
      supplierSnapshot: texts.snapshot.supplier,
      customerSnapshot: texts.snapshot.customer,
      accountSnapshot: texts.snapshot.account,
      searchText: searchTextOf({
        number,
        customerName: texts.customerName,
        lines: texts.lines,
      }),
      revision: row.revision + 1,
      issuedAt: now,
      updatedAt: now,
    })
    .where(and(eq(invoice.id, id), eq(invoice.userId, userId)))
    .run();

  const changes = diffLines(lines, issuedLines);
  audit({
    action: "invoice.issue",
    entity: "invoice",
    entityId: id,
    ownerId: userId,
    scope: "user",
    before: {
      ...auditSnapshot(stored, lines.length),
      ...(changes && { lines: changes.before }),
    },
    after: {
      ...auditSnapshot(findOwned(tx, userId, id), lines.length),
      ...(changes && { lines: changes.after }),
      ...(skipped.length > 0 && { skippedNumbers: skipped }),
      ...(catalogUse.length > 0 && { catalogUse }),
    },
  });
  if (isNote) refreshBalance(tx, audit, userId, row.relatedInvoiceId!);
  return { id, number };
}

export function issueInvoice(
  actor: Actor,
  id: string,
  opts: IssueOptions,
): { id: string; number: string } {
  const userId = ownerOf(actor);
  return mutate(actor, "invoice.issue", (tx, audit) => issueIn(tx, audit, userId, id, opts));
}

type StatusChange = {
  status: InvoiceStatus;
  cancelledFrom?: InvoiceStatus | null;
  sentAt?: Date;
};

function changeStatus(
  actor: Actor,
  id: string,
  action: AuditAction,
  change: (row: Invoice, tx: Tx) => StatusChange,
): void {
  const userId = ownerOf(actor);
  mutate(actor, action, (tx, audit) => {
    const row = findOwned(tx, userId, id);
    const values = change(row, tx);
    tx.update(invoice)
      .set({ ...values, revision: row.revision + 1, updatedAt: clock.now() })
      .where(and(eq(invoice.id, id), eq(invoice.userId, userId)))
      .run();
    audit({
      entity: "invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { status: row.status, cancelledFrom: row.cancelledFrom },
      after: values,
    });
    const leftOrReturned = isActiveDocument(row.status) !== isActiveDocument(values.status);
    if (row.type === "credit_note" && row.relatedInvoiceId && leftOrReturned) {
      refreshBalance(tx, audit, userId, row.relatedInvoiceId);
    }
  });
}

export function cancelInvoice(actor: Actor, id: string): void {
  changeStatus(actor, id, "invoice.cancel", (row, tx) => {
    if (hasPayments(tx, row.userId, id)) throw new ServiceError(V.hasPayments);
    if (row.creditsMinor < 0) throw new ServiceError(V.hasCredits);
    if (row.status !== "issued" && row.status !== "sent") throw new ServiceError(V.notCancellable);
    return { status: "cancelled", cancelledFrom: row.status };
  });
}

export function restoreInvoice(actor: Actor, id: string): void {
  changeStatus(actor, id, "invoice.restore", (row, tx) => {
    if (row.status !== "cancelled" || !row.cancelledFrom) throw new ServiceError(V.notCancelled);
    const problem = row.type === "credit_note" && creditNoteProblem(tx, row.userId, row);
    if (problem) throw new ServiceError(problem);
    return { status: row.cancelledFrom, cancelledFrom: null };
  });
}

// A document settled before it left still has to record sending, or removing the payment or the
// credit note would put it back to issued although the client has it.
function paidBeforeSending(row: Invoice): boolean {
  const settled = ["partially_paid", "paid", "credited"].includes(row.status);
  return settled && row.sentAt === null;
}

export function markSent(actor: Actor, id: string): void {
  changeStatus(actor, id, "invoice.mark_sent", (row) => {
    if (row.status === "issued") return { status: "sent", sentAt: clock.now() };
    if (paidBeforeSending(row)) return { status: row.status, sentAt: clock.now() };
    throw new ServiceError(V.notMarkable);
  });
}

// Only an issued document changes status: a paid one stays paid when it is sent (INV-005).
export function applySent(tx: Tx, userId: string, invoiceId: string): void {
  const row = findOwned(tx, userId, invoiceId);
  if (row.status !== "issued" && !paidBeforeSending(row)) return;
  const now = clock.now();
  tx.update(invoice)
    .set({
      status: row.status === "issued" ? "sent" : row.status,
      sentAt: now,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(eq(invoice.id, invoiceId), eq(invoice.userId, userId)))
    .run();
}

// A batch stops for nobody: one document already changed elsewhere must not block the others.
export function markSentMany(actor: Actor, ids: string[]): { done: number; skipped: number } {
  let done = 0;
  const unique = [...new Set(ids)];
  for (const id of unique) {
    try {
      markSent(actor, id);
      done += 1;
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
    }
  }
  return { done, skipped: unique.length - done };
}
