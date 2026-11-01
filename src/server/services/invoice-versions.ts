import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { InvoiceStatus } from "@/lib/invoice";
import { diffInvoices, diffLines, type LineRow } from "@/lib/invoice-diff";
import { invoiceDocument, type InvoiceDocument } from "@/lib/invoice-document";
import { deriveStatus } from "@/lib/payments";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  bankAccount,
  catalogItem,
  invoice,
  invoiceLine,
  invoiceVersion,
  numberSeries,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "./access";
import { recordCatalogUse } from "./catalog";
import { creditLimitProblem } from "./credit-notes";
import { hasPayments, refreshBalance } from "./invoice-balance";
import { currentParties } from "./invoice-document";
import {
  automaticSymbol,
  documentProblems,
  NotIssuableError,
  vatStatementProblems,
} from "./invoice-lifecycle";
import {
  assertReferencesOwned,
  auditSnapshot,
  findOwned,
  insertLines,
  issuedInputSchema,
  lineRows,
  linesOf,
  matches,
  normalizedRate,
  ownerOf,
  searchTextOf,
  sumsOf,
  totalsOf,
  Unchanged,
  unlessUnchanged,
  type Invoice,
  type InvoiceLine,
  type IssuedInput,
} from "./invoices";
import { mutate } from "./mutation";
import { isNumberTaken } from "./number-series";

const V = TEXTS.invoices.validation;

// A credited document is settled by its credit notes, so it stays out as well.
export const EDITABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  "issued",
  "sent",
  "partially_paid",
  "paid",
]);

export type BalanceWarning = "none" | "overpaid" | "underpaid";
export type EditResult = {
  revision: number;
  variableSymbol: string | null;
  resendSuggested: boolean;
  balanceWarning: BalanceWarning;
  status: InvoiceStatus;
};
export type InvoiceVersion = typeof invoiceVersion.$inferSelect;
export type InvoiceVersionSummary = Omit<InvoiceVersion, "document" | "userId">;

type Audit = Parameters<Parameters<typeof mutate>[2]>[1];
type InvoiceValues = Partial<typeof invoice.$inferInsert>;
type Change = {
  values: InvoiceValues;
  rows?: LineRow[];
  note?: Record<string, unknown>;
};

function assertEditable(row: Invoice): void {
  if (!EDITABLE_STATUSES.has(row.status)) throw new ServiceError(V.notEditable);
}

// Underpaid is the move out of paid: a document already partially paid has nothing new to warn of.
function balanceWarningOf(row: Invoice, statusBefore: InvoiceStatus): BalanceWarning {
  if (row.type === "credit_note") return "none";
  if (amountDue(row) < 0) return "overpaid";
  return statusBefore === "paid" && row.status === "partially_paid" ? "underpaid" : "none";
}

function resultOf(row: Invoice, changed: boolean, statusBefore = row.status): EditResult {
  return {
    revision: row.revision,
    variableSymbol: row.variableSymbol,
    resendSuggested: changed && row.sentAt !== null,
    balanceWarning: balanceWarningOf(row, statusBefore),
    status: row.status,
  };
}

// Lines are rewritten on every edit, so only uses beyond those already counted may add up.
function recordAddedCatalogUse(
  tx: Tx,
  ownerId: string,
  before: Pick<InvoiceLine, "catalogItemId">[],
  after: Pick<LineRow, "catalogItemId">[],
): void {
  const counted = new Map<string, number>();
  for (const { catalogItemId } of before) {
    if (catalogItemId) counted.set(catalogItemId, (counted.get(catalogItemId) ?? 0) + 1);
  }
  for (const { catalogItemId } of after) {
    if (!catalogItemId) continue;
    const left = counted.get(catalogItemId) ?? 0;
    if (left > 0) counted.set(catalogItemId, left - 1);
    else recordCatalogUse(tx, ownerId, catalogItemId);
  }
}

function documentOf(row: Invoice, lines: InvoiceLine[]): InvoiceDocument {
  return invoiceDocument({ ...row, lines });
}

function writeVersion(tx: Tx, ownerId: string, row: Invoice, lines: InvoiceLine[]): number {
  const last = tx
    .select({ versionNo: max(invoiceVersion.versionNo) })
    .from(invoiceVersion)
    .where(scoped(ownerId).where(invoiceVersion, (t, { eq }) => eq(t.invoiceId, row.id)))
    .get();
  const versionNo = (last?.versionNo ?? 0) + 1;
  tx.insert(invoiceVersion)
    .values({
      id: randomUUID(),
      invoiceId: row.id,
      userId: ownerId,
      versionNo,
      document: documentOf(row, lines),
      createdAt: clock.now(),
    })
    .run();
  return versionNo;
}

// In applyChange, so restoring a version cannot get around it. A final invoice locks only its
// currency: advance_minor is in that currency, while its rate is its own.
function assertLinkedMoney(tx: Tx, ownerId: string, before: Invoice, values: InvoiceValues): void {
  const isNote = before.type === "credit_note";
  const credited = before.creditsMinor < 0;
  const newCurrency = values.currency !== undefined && values.currency !== before.currency;
  const newRate =
    values.exchangeRateMicros !== undefined &&
    values.exchangeRateMicros !== before.exchangeRateMicros;
  if (
    (newCurrency && before.relatedInvoiceId) ||
    ((isNote || credited) && (newCurrency || newRate))
  ) {
    throw new ServiceError(V.currencyHasCredits);
  }
  const candidate = { ...before, ...values };
  if (credited && candidate.totalMinor < -before.creditsMinor) {
    throw new ServiceError(V.creditsExceedTotal);
  }
  const problem = isNote && creditLimitProblem(tx, ownerId, candidate);
  if (problem) throw new ServiceError(problem);
}

function applyChange(
  tx: Tx,
  audit: Audit,
  ownerId: string,
  before: Invoice,
  { values, rows, note }: Change,
): EditResult {
  const id = before.id;
  // credited_minor is in the document currency, so changing it would silently restate the money.
  const newCurrency = values.currency !== undefined && values.currency !== before.currency;
  if (newCurrency && hasPayments(tx, ownerId, id)) throw new ServiceError(V.currencyHasPayments);
  assertLinkedMoney(tx, ownerId, before, values);
  const beforeLines = linesOf(tx, ownerId, id);
  const versionNo = writeVersion(tx, ownerId, before, beforeLines);
  const candidate = { ...before, ...values };
  tx.update(invoice)
    .set({
      ...values,
      status: deriveStatus(candidate),
      searchText: searchTextOf({ ...candidate, lines: rows ?? beforeLines }),
      revision: before.revision + 1,
      updatedAt: clock.now(),
    })
    .where(and(eq(invoice.id, id), eq(invoice.userId, ownerId)))
    .run();
  if (rows) {
    tx.delete(invoiceLine)
      .where(scoped(ownerId).where(invoiceLine, (t, { eq }) => eq(t.invoiceId, id)))
      .run();
    insertLines(tx, ownerId, id, rows);
    recordAddedCatalogUse(tx, ownerId, beforeLines, rows);
  }

  const edited = findOwned(tx, ownerId, id);
  const changes = rows ? diffLines(beforeLines, rows) : null;
  const lineCount = (rows ?? beforeLines).length;
  audit({
    entity: "invoice",
    entityId: id,
    ownerId,
    scope: "user",
    before: {
      ...auditSnapshot(before, beforeLines.length),
      ...(changes && { lines: changes.before }),
    },
    after: {
      ...auditSnapshot(edited, lineCount),
      ...note,
      versionNo,
      ...(changes && { lines: changes.after }),
    },
  });
  if (before.relatedInvoiceId && before.type === "credit_note") {
    if (edited.totalMinor !== before.totalMinor) {
      refreshBalance(tx, audit, ownerId, before.relatedInvoiceId);
    }
  }
  return resultOf(edited, true, before.status);
}

function accountSnapshotFor(
  tx: Tx,
  ownerId: string,
  before: Invoice,
  bankAccountId: string | null,
) {
  if (bankAccountId === before.bankAccountId) return before.accountSnapshot;
  const parties = currentParties(tx, ownerId, {
    customerId: null,
    bankAccountId,
  });
  return parties.snapshot.account;
}

// An untouched symbol keeps following the number unless it was written by hand. A typed one is
// manual only while it differs from what the number gives, so retyping that hands it back.
function symbolValues(
  ownerId: string,
  before: Invoice,
  number: string,
  requested: string | null | undefined,
): InvoiceValues {
  if (before.type === "credit_note") return {};
  const automatic = automaticSymbol(ownerId, number);
  const current = before.variableSymbol ?? "";
  const wanted = requested ?? current;
  if (wanted !== current) {
    return { variableSymbol: wanted || null, variableSymbolManual: wanted !== (automatic ?? "") };
  }
  const follows = number !== before.number && !before.variableSymbolManual;
  return follows ? { variableSymbol: automatic } : {};
}

export function updateIssuedInvoice(actor: Actor, id: string, raw: IssuedInput): EditResult {
  const userId = ownerOf(actor);
  const parsed = issuedInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? V.invalid);
  const { revision, lines, variableSymbol, ...fields } = parsed.data;
  const totals = totalsOf(lines, fields);
  const rows = lineRows(lines, totals);

  return unlessUnchanged(() =>
    mutate(actor, "invoice.update", (tx, audit) => {
      const before = findOwned(tx, userId, id);
      assertEditable(before);
      if (before.revision !== revision) throw new ServiceError(TEXTS.invoices.stale);

      const values: InvoiceValues = {
        ...fields,
        ...normalizedRate(fields, before),
        ...sumsOf(totals),
        accountSnapshot: accountSnapshotFor(tx, userId, before, fields.bankAccountId),
        ...symbolValues(userId, before, fields.number, variableSymbol),
      };
      const beforeLines = linesOf(tx, userId, id);
      if (
        matches(before, values) &&
        beforeLines.length === rows.length &&
        rows.every((row, i) => matches(beforeLines[i]!, row))
      ) {
        throw new Unchanged(resultOf(before, false));
      }

      assertReferencesOwned(tx, userId, { ...before, ...parsed.data });
      if (isNumberTaken(tx, userId, fields.number, id)) throw new ServiceError(V.numberTaken);
      const candidate = { ...before, ...values };
      const problems = documentProblems(tx, userId, candidate, rows, before.bankAccountId);
      if (problems.length > 0) throw new NotIssuableError(problems);

      return applyChange(tx, audit, userId, before, { values, rows });
    }),
  );
}

export function refreshCustomerSnapshot(actor: Actor, id: string): EditResult {
  const userId = ownerOf(actor);
  return unlessUnchanged(() =>
    mutate(actor, "invoice.refresh_customer", (tx, audit) => {
      const before = findOwned(tx, userId, id);
      assertEditable(before);
      const customerSnapshot = currentParties(tx, userId, before).snapshot.customer;
      if (!customerSnapshot) throw new ServiceError(V.customerNotFound);
      const values = { customerSnapshot, customerName: customerSnapshot.name };
      if (matches(before, values)) throw new Unchanged(resultOf(before, false));
      return applyChange(tx, audit, userId, before, { values });
    }),
  );
}

function liveId(
  q: Reader,
  ownerId: string,
  table: typeof bankAccount | typeof numberSeries,
  id: string | null,
): string | null {
  if (!id) return null;
  const row = q
    .select({ id: table.id })
    .from(table)
    .where(scoped(ownerId).where(table, (t, { eq }) => eq(t.id, id)))
    .get();
  return row?.id ?? null;
}

// History does not hold references alive: an account or catalog item may be gone by now, while the
// snapshots and line copies keep the document intact without the link.
function withLiveReferences(
  q: Reader,
  ownerId: string,
  document: InvoiceDocument,
): InvoiceDocument {
  const itemIds = [...new Set(document.lines.flatMap((line) => line.catalogItemId ?? []))];
  const items = q
    .select({ id: catalogItem.id })
    .from(catalogItem)
    .where(scoped(ownerId).where(catalogItem, (t) => inArray(t.id, itemIds)))
    .all();
  const liveItems = new Set(items.map((item) => item.id));
  return {
    ...document,
    bankAccountId: liveId(q, ownerId, bankAccount, document.bankAccountId),
    seriesId: liveId(q, ownerId, numberSeries, document.seriesId),
    lines: document.lines.map((line) => ({
      ...line,
      catalogItemId:
        line.catalogItemId && liveItems.has(line.catalogItemId) ? line.catalogItemId : null,
    })),
  };
}

// Stored versions predate some fields, and JSON keeps a date as text.
function completeDocument(document: InvoiceDocument): InvoiceDocument {
  const { creditsMinor, advanceMinor, supersededAt } = document.totals;
  return {
    ...document,
    relatedDocument: document.relatedDocument ?? null,
    foreign: document.foreign ?? false,
    clause: document.clause ?? "",
    totals: {
      ...document.totals,
      creditsMinor: creditsMinor ?? 0,
      advanceMinor: advanceMinor ?? 0,
      supersededAt: supersededAt ? new Date(supersededAt) : null,
    },
  };
}

function readVersion(q: Reader, ownerId: string, id: string): InvoiceVersion | null {
  const row = q
    .select()
    .from(invoiceVersion)
    .where(scoped(ownerId).where(invoiceVersion, (t, { eq }) => eq(t.id, id)))
    .get();
  return row ? { ...row, document: completeDocument(row.document) } : null;
}

export function listVersions(ownerId: string, invoiceId: string): InvoiceVersionSummary[] {
  return db
    .select({
      id: invoiceVersion.id,
      invoiceId: invoiceVersion.invoiceId,
      versionNo: invoiceVersion.versionNo,
      createdAt: invoiceVersion.createdAt,
    })
    .from(invoiceVersion)
    .where(scoped(ownerId).where(invoiceVersion, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .orderBy(desc(invoiceVersion.versionNo))
    .all();
}

export function getVersion(ownerId: string, versionId: string): InvoiceVersion | null {
  return readVersion(db, ownerId, versionId);
}

// Payments and the balance are not part of a version, they record what has happened since, and
// status follows them.
export function restoreVersion(actor: Actor, versionId: string): EditResult {
  const userId = ownerOf(actor);
  return unlessUnchanged(() =>
    mutate(actor, "invoice.restore_version", (tx, audit) => {
      const version = readVersion(tx, userId, versionId);
      if (!version) throw new ServiceError(V.versionNotFound);
      const before = findOwned(tx, userId, version.invoiceId);
      assertEditable(before);

      const document = withLiveReferences(tx, userId, version.document);
      const current = documentOf(before, linesOf(tx, userId, before.id));
      if (diffInvoices(current, document).length === 0)
        throw new Unchanged(resultOf(before, false));
      if (document.number && isNumberTaken(tx, userId, document.number, before.id)) {
        throw new ServiceError(V.numberTaken);
      }

      const {
        id: _i,
        type: _t,
        status: _s,
        lines,
        snapshot,
        images,
        totals: _o,
        relatedDocument,
        ...header
      } = document;
      const totals = totalsOf(lines, document);
      const values: InvoiceValues = {
        ...header,
        ...normalizedRate(document, before),
        ...images,
        ...sumsOf(totals),
        supplierSnapshot: snapshot.supplier,
        customerSnapshot: snapshot.customer,
        accountSnapshot: snapshot.account,
        relatedSnapshot: relatedDocument,
      };
      // Only this check: the rest of documentProblems would refuse a version whose account is gone.
      const problems = vatStatementProblems(tx, userId, { ...before, ...values });
      if (problems.length > 0) throw new NotIssuableError(problems);
      return applyChange(tx, audit, userId, before, {
        values,
        rows: lineRows(lines, totals),
        note: { restoredFrom: version.versionNo },
      });
    }),
  );
}
