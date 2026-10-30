import "server-only";
import { and, eq } from "drizzle-orm";
import type { InvoiceStatus } from "@/lib/invoice";
import { variableSymbolFrom } from "@/lib/number-format";
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
  diffLines,
  findOwned,
  linesOf,
  ownerOf,
  searchTextOf,
  sumsOf,
  totalsOf,
  type Invoice,
  type InvoiceLine,
} from "./invoices";
import { mutate } from "./mutation";
import { allocateNumber, defaultSeriesFor, type NumberSeries } from "./number-series";
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
  const problem = (message: string) => ({ problem: { field: "seriesId", message } });
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

function lineProblems(lines: InvoiceLine[]): IssueProblem[] {
  if (lines.length === 0) return [{ field: "lines", message: T.noLines }];
  return lines.flatMap((line, i) => {
    const position = i + 1;
    const found: IssueProblem[] = [];
    if (!line.name.trim()) {
      found.push({ field: `lines.${i}.name`, message: T.lineName(position) });
    }
    if (line.quantityMilli <= 0) {
      found.push({ field: `lines.${i}.quantityMilli`, message: T.lineQuantity(position) });
    }
    if (line.unitPriceMinor < 0) {
      found.push({ field: `lines.${i}.unitPriceMinor`, message: T.linePrice(position) });
    }
    return found;
  });
}

function amountProblems(row: Invoice, lines: InvoiceLine[]): IssueProblem[] {
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
function accountProblems(q: Reader, ownerId: string, row: Invoice): IssueProblem[] {
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
  if (account.hidden) return problem(T.accountHidden);
  return account.currency === row.currency ? [] : problem(T.accountCurrency(row.currency));
}

function draftProblems(q: Reader, ownerId: string, row: Invoice, lines: InvoiceLine[]) {
  const ofLines = lineProblems(lines);
  const found = [
    ...supplierProblems(ownerId),
    ...(row.customerId ? [] : [{ field: "customerId", message: T.customer }]),
    ...ofLines,
    ...(ofLines.length === 0 ? amountProblems(row, lines) : []),
    ...dateProblems(row),
    ...accountProblems(q, ownerId, row),
  ];
  if (row.currency !== "CZK" && !row.exchangeRateMicros) {
    found.push({ field: "exchangeRateMicros", message: T.exchangeRate(row.currency) });
  }
  return found;
}

export function checkIssuable(ownerId: string, id: string): IssueProblem[] {
  const row = findOwned(db, ownerId, id);
  if (row.status !== "draft") return [{ field: "status", message: T.alreadyIssued }];
  const found = draftProblems(db, ownerId, row, linesOf(db, ownerId, id));
  const picked = pickSeries(db, ownerId, row, row.seriesId);
  return "problem" in picked ? [...found, picked.problem] : found;
}

function issuedTexts(tx: Tx, userId: string, row: Invoice, lines: InvoiceLine[], number: string) {
  const parties = currentParties(tx, userId, row);
  const customerName = parties.snapshot.customer?.name ?? row.customerName;
  const texts = renderDocumentTexts(row, lines, variablesFor(userId, row, number, customerName));
  return { ...texts, ...parties, customerName };
}

function storeLines(tx: Tx, before: InvoiceLine[], after: InvoiceLine[]): void {
  after.forEach((line, i) => {
    if (line.name === before[i]!.name && line.description === before[i]!.description) return;
    tx.update(invoiceLine)
      .set({ name: line.name, description: line.description })
      .where(eq(invoiceLine.id, line.id))
      .run();
  });
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
    const automaticSymbol =
      getPreferences(userId).variableSymbolFormat === "digits" ? variableSymbolFrom(number) : "";
    const now = clock.now();

    storeLines(tx, lines, texts.lines);
    for (const line of lines) {
      if (line.catalogItemId) recordCatalogUse(tx, userId, line.catalogItemId);
    }
    tx.update(invoice)
      .set({
        ...sumsOf(totals),
        ...texts.images,
        status: "issued",
        number,
        variableSymbol: manualSymbol ?? (automaticSymbol || null),
        variableSymbolManual: manualSymbol !== undefined,
        seriesId: picked.series.id,
        customerName: texts.customerName,
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

    const changes = diffLines(lines, texts.lines);
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
