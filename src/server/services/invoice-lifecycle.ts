import "server-only";
import { and, eq } from "drizzle-orm";
import type { InvoiceStatus } from "@/lib/invoice";
import { diffLines } from "@/lib/invoice-diff";
import { calendarDateInPrague, variableSymbolFrom } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import type { AuditAction } from "../audit/record";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { bankAccount, invoice, invoiceLine, numberSeries } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { recordCatalogUse } from "./catalog";
import { currentParties, renderDocumentTexts, variablesFor } from "./invoice-document";
import {
  auditSnapshot,
  findOwned,
  linesOf,
  MAX_DOCUMENT_TEXT,
  MAX_LINE_NAME,
  ownerOf,
  searchTextOf,
  sumsOf,
  totalsOf,
  type Invoice,
  type InvoiceLine,
} from "./invoices";
import { mutate } from "./mutation";
import { allocateNumber, defaultSeriesFor, peekNumber, type NumberSeries } from "./number-series";
import { getPreferences } from "./preferences";
import { missingSupplierKeys } from "./supplier";

const V = TEXTS.invoices.validation;
const T = TEXTS.invoices.issue;
const MANUAL_VARIABLE_SYMBOL = /^\d{1,10}$/;

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

// The statement is printed in the document's language, so only that one has to be filled in.
function vatStatementProblems(q: Reader, ownerId: string, row: Invoice): IssueProblem[] {
  const profile = currentParties(q, ownerId, row).snapshot.supplier;
  if (!profile) return [];
  const key = row.language === "en" ? "notVatPayerEn" : "notVatPayerCs";
  if (profile[key].trim()) return [];
  return [{ field: `supplier.${key}`, message: T.notVatPayer(TEXTS.supplier.fields[key]) }];
}

type CheckedLine = Pick<
  InvoiceLine,
  "name" | "quantityMilli" | "unitPriceMinor" | "discountKind" | "discountValue"
>;

function lineProblems(lines: CheckedLine[]): IssueProblem[] {
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
    if (line.unitPriceMinor < 0) {
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

// The supplier is frozen in the snapshot of an issued document, so only issuing checks it.
export function documentProblems(
  q: Reader,
  ownerId: string,
  row: Invoice,
  lines: CheckedLine[],
  keptAccountId: string | null = null,
): IssueProblem[] {
  const ofLines = lineProblems(lines);
  const found = [
    ...(row.customerId ? [] : [{ field: "customerId", message: T.customer }]),
    ...ofLines,
    ...(ofLines.length === 0 ? amountProblems(row, lines) : []),
    ...dateProblems(row),
    ...accountProblems(q, ownerId, row, keptAccountId),
  ];
  if (row.currency !== "CZK" && !row.exchangeRateMicros) {
    found.push({
      field: "exchangeRateMicros",
      message: T.exchangeRate(row.currency),
    });
  }
  return found;
}

function draftProblems(q: Reader, ownerId: string, row: Invoice, lines: InvoiceLine[]) {
  return [
    ...supplierProblems(ownerId),
    ...vatStatementProblems(q, ownerId, row),
    ...documentProblems(q, ownerId, row, lines),
  ];
}

export function checkIssuable(ownerId: string, id: string): IssueProblem[] {
  const row = findOwned(db, ownerId, id);
  if (row.status !== "draft") return [{ field: "status", message: T.alreadyIssued }];
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

export type IssuePreview = {
  problems: IssueProblem[];
  number: string | null;
  variableSymbol: string | null;
  issueDate: string | null;
  today: string;
};

export function previewIssue(ownerId: string, id: string): IssuePreview {
  const row = findOwned(db, ownerId, id);
  const picked = pickSeries(db, ownerId, row, row.seriesId);
  const number =
    "series" in picked && row.issueDate
      ? peekNumber(db, ownerId, picked.series, row.issueDate)
      : null;
  return {
    problems: checkIssuable(ownerId, id),
    number,
    variableSymbol: number && automaticSymbol(ownerId, number),
    issueDate: row.issueDate,
    today: calendarDateInPrague(clock.now()),
  };
}

// Variables can outgrow the limits saveDraft enforced, and editing an issued document validates
// against the same limits, so an oversized text would make the document uneditable.
function textProblems(texts: {
  textBefore: string;
  textAfter: string;
  note: string;
  lines: Pick<InvoiceLine, "name" | "description">[];
}): IssueProblem[] {
  const found: IssueProblem[] = [];
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

function storeLines(tx: Tx, before: InvoiceLine[], after: InvoiceLine[]): void {
  after.forEach((line, i) => {
    const { name, description, netMinor } = line;
    const old = before[i]!;
    if (name === old.name && description === old.description && netMinor === old.netMinor) return;
    tx.update(invoiceLine)
      .set({ name, description, netMinor })
      .where(eq(invoiceLine.id, line.id))
      .run();
  });
}

export function automaticSymbol(ownerId: string, number: string): string | null {
  const format = getPreferences(ownerId).variableSymbolFormat;
  return (format === "digits" && variableSymbolFrom(number)) || null;
}

export function issueInvoice(
  actor: Actor,
  id: string,
  opts: { revision: number; seriesId?: string; variableSymbol?: string },
): { id: string; number: string } {
  const userId = ownerOf(actor);
  const manualSymbol = opts.variableSymbol;
  if (manualSymbol !== undefined && !MANUAL_VARIABLE_SYMBOL.test(manualSymbol)) {
    throw new ServiceError(V.variableSymbol);
  }

  return mutate(actor, "invoice.issue", (tx, audit) => {
    const row = findOwned(tx, userId, id);
    if (row.status !== "draft" || row.revision !== opts.revision) {
      throw new ServiceError(TEXTS.invoices.stale);
    }
    const lines = linesOf(tx, userId, id);
    const picked = pickSeries(tx, userId, row, opts.seriesId ?? row.seriesId);
    const problems = draftProblems(tx, userId, row, lines);
    if ("problem" in picked) problems.push(picked.problem);
    if (problems.length > 0 || "problem" in picked) throw new NotIssuableError(problems);

    const totals = totalsOf(lines, row);
    const { number } = allocateNumber(tx, userId, picked.series.id, row.issueDate!);
    const texts = issuedTexts(tx, userId, row, lines, number);
    const overLimit = textProblems(texts);
    if (overLimit.length > 0) throw new NotIssuableError(overLimit);
    const issuedLines = texts.lines.map((line, i) => ({
      ...line,
      netMinor: totals.lines[i]!.netMinor,
    }));
    const now = clock.now();

    storeLines(tx, lines, issuedLines);
    for (const line of lines) {
      if (line.catalogItemId) recordCatalogUse(tx, userId, line.catalogItemId);
    }
    tx.update(invoice)
      .set({
        ...sumsOf(totals),
        ...texts.images,
        status: "issued",
        number,
        variableSymbol: manualSymbol ?? automaticSymbol(userId, number),
        variableSymbolManual: manualSymbol !== undefined,
        seriesId: picked.series.id,
        customerName: texts.customerName,
        dateFormat: texts.dateFormat,
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
      entity: "invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: {
        ...auditSnapshot(row, lines.length),
        ...(changes && { lines: changes.before }),
      },
      after: {
        ...auditSnapshot(findOwned(tx, userId, id), lines.length),
        ...(changes && { lines: changes.after }),
      },
    });
    return { id, number };
  });
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
  change: (row: Invoice) => StatusChange,
): void {
  const userId = ownerOf(actor);
  mutate(actor, action, (tx, audit) => {
    const row = findOwned(tx, userId, id);
    const values = change(row);
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
  });
}

export function cancelInvoice(actor: Actor, id: string): void {
  changeStatus(actor, id, "invoice.cancel", (row) => {
    if (row.status !== "issued" && row.status !== "sent") throw new ServiceError(V.notCancellable);
    return { status: "cancelled", cancelledFrom: row.status };
  });
}

export function restoreInvoice(actor: Actor, id: string): void {
  changeStatus(actor, id, "invoice.restore", (row) => {
    if (row.status !== "cancelled" || !row.cancelledFrom) throw new ServiceError(V.notCancelled);
    return { status: row.cancelledFrom, cancelledFrom: null };
  });
}

export function markSent(actor: Actor, id: string): void {
  changeStatus(actor, id, "invoice.mark_sent", (row) => {
    if (row.status !== "issued") throw new ServiceError(V.notMarkable);
    return { status: "sent", sentAt: clock.now() };
  });
}
