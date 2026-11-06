// No server-only: Playwright loads this through tests/helpers/consistency.ts.
import { asc, sql, type SQL } from "drizzle-orm";
import { EXCHANGE_RATE_SOURCES } from "@/lib/fx";
import { isActiveDocument, toDiscount } from "@/lib/invoice";
import { computeTotals } from "@/lib/invoice-totals";
import { deriveStatus } from "@/lib/payments";
import type { Db, Tx } from "../db";
import { invoice, invoiceLine } from "../db/schema";
import { scoped } from "../db/scoped";

// Invariants of stored account data. A restore copies its values literally and runs these at the
// end of its transaction; tests/helpers/consistency.ts runs them after every scenario.

type Checker = Db | Tx;
type Invoice = typeof invoice.$inferSelect;
type Line = typeof invoiceLine.$inferSelect;

function count(q: Checker, query: SQL): number {
  return q.get<{ n: number }>(query)?.n ?? 0;
}

type ById = Map<string, Invoice>;

function creditNoteProblems(row: Invoice, byId: ById, label: string): string[] {
  const problems: string[] = [];
  if (row.totalMinor >= 0) problems.push(`${label}: oprava není záporná`);
  if (row.variableSymbol !== null) problems.push(`${label}: oprava má variabilní symbol`);
  const original = row.relatedInvoiceId ? byId.get(row.relatedInvoiceId) : undefined;
  if (!original) return [...problems, `${label}: oprava bez původní faktury`];
  if (!row.relatedSnapshot) problems.push(`${label}: oprava bez zamrzlého odkazu`);
  if (original.currency !== row.currency) problems.push(`${label}: oprava v jiné měně`);
  if (original.totalMinor + original.creditsMinor < 0) {
    problems.push(`${label}: opravy přečerpaly fakturu`);
  }
  return problems;
}

function finalProblems(row: Invoice, byId: ById, label: string): string[] {
  const advance = row.relatedInvoiceId ? byId.get(row.relatedInvoiceId) : undefined;
  if (advance?.type !== "advance") return [`${label}: konečná faktura bez zálohy`];
  const problems: string[] = [];
  if (advance.currency !== row.currency) problems.push(`${label}: faktura v jiné měně než záloha`);
  if (advance.customerId !== row.customerId) {
    problems.push(`${label}: faktura pro jiného zákazníka než záloha`);
  }
  return problems;
}

// Every check walks the rows once and looks related documents up in maps, so a restore of a large
// archive spends linear time here inside its transaction (I-4).
function relatedBy(rows: Invoice[], keep: (row: Invoice) => boolean): Map<string, Invoice[]> {
  const out = new Map<string, Invoice[]>();
  for (const row of rows) {
    if (!row.relatedInvoiceId || !keep(row)) continue;
    const list = out.get(row.relatedInvoiceId);
    if (list) list.push(row);
    else out.set(row.relatedInvoiceId, [row]);
  }
  return out;
}

function advanceProblems(rows: Invoice[]): string[] {
  const finalsOf = relatedBy(rows, (row) => row.type === "invoice" && row.status !== "cancelled");
  const problems: string[] = [];
  for (const row of rows) {
    if (row.type !== "advance") continue;
    const finals = finalsOf.get(row.id) ?? [];
    if (finals.length > 1) problems.push(`invoice ${row.id}: více aktivních konečných faktur`);
    let issued = false;
    for (const other of finals) if (other.status !== "draft") issued = true;
    if ((row.supersededAt !== null) !== issued) {
      problems.push(`invoice ${row.id}: superseded_at neodpovídá konečné faktuře`);
    }
  }
  return problems;
}

function rateProblems(row: Invoice, label: string): string[] {
  const { currency, status, exchangeRateMicros: micros } = row;
  const { exchangeRateSource: source, exchangeRateDate: listDate } = row;
  const problems: string[] = [];
  if (source !== null && !EXCHANGE_RATE_SOURCES.includes(source)) {
    problems.push(`${label}: neznámý zdroj kurzu ${source}`);
  }
  if ((source === "import") !== (row.external && currency !== "CZK")) {
    problems.push(`${label}: zdroj kurzu import neodpovídá importovanému dokladu v cizí měně`);
  }
  if (currency === "CZK") {
    if (micros !== null || source !== null || listDate !== null) {
      problems.push(`${label}: doklad v CZK drží kurz`);
    }
    return problems;
  }
  if (status === "draft") return problems;
  // R-13: a file without a usable rate still becomes a document, counted as unconverted.
  if (source === "import") {
    if ((micros === null) !== (listDate === null)) {
      problems.push(`${label}: importovaný kurz a jeho datum nejdou spolu`);
    }
    return problems;
  }
  if (micros === null) problems.push(`${label}: vystavený doklad v cizí měně nemá kurz`);
  if (source === null) problems.push(`${label}: vystavený doklad v cizí měně nemá zdroj kurzu`);
  // Only a list has a date: a fixed or typed rate never came from one.
  if ((source === "cnb" || source === "last_known") && listDate === null) {
    problems.push(`${label}: kurz z lístku nemá datum`);
  }
  return problems;
}

function ownTotalsProblems(row: Invoice, lines: Line[], label: string): string[] {
  try {
    const totals = computeTotals(
      lines.map((line) => ({
        quantityMilli: line.quantityMilli,
        unitPriceMinor: line.unitPriceMinor,
        discount: toDiscount(line.discountKind, line.discountValue),
      })),
      toDiscount(row.discountKind, row.discountValue),
      row.rounding,
    );
    const matches =
      row.subtotalMinor === totals.subtotalMinor &&
      row.discountMinor === totals.discountMinor &&
      row.roundingMinor === totals.roundingMinor &&
      row.totalMinor === totals.totalMinor &&
      lines.every((line, i) => line.netMinor === totals.lines[i]!.netMinor);
    return matches ? [] : [`${label}: uložené součty neodpovídají položkám`];
  } catch {
    return [`${label}: součty nejde spočítat`];
  }
}

// R-12: an imported document keeps its file's amounts, so only the arithmetic between them holds.
function externalProblems(row: Invoice, lines: Line[], label: string): string[] {
  const problems: string[] = [];
  if (row.subtotalMinor - row.discountMinor + row.roundingMinor !== row.totalMinor) {
    problems.push(`${label}: součty importovaného dokladu nesedí`);
  }
  const net = lines.reduce((sum, line) => sum + line.netMinor, 0);
  if (net !== row.subtotalMinor) problems.push(`${label}: položky importu nedávají mezisoučet`);
  if (row.status === "draft" || row.status === "cancelled") {
    problems.push(`${label}: importovaný doklad ve stavu ${row.status}`);
  }
  if (row.sentAt !== null) problems.push(`${label}: importovaný doklad má datum odeslání`);
  if (row.importBatchId === null) problems.push(`${label}: importovaný doklad bez dávky`);
  return problems;
}

export function invoiceProblems(q: Checker, ownerId: string): string[] {
  // An instance without accounts is checked with an empty owner; it has no documents to judge.
  if (!ownerId) return [];
  const problems: string[] = [];
  const rows = q.select().from(invoice).where(scoped(ownerId).where(invoice)).all();
  const byId: ById = new Map(rows.map((row) => [row.id, row]));
  const linesOf = new Map<string, Line[]>();
  for (const line of q
    .select()
    .from(invoiceLine)
    .where(scoped(ownerId).where(invoiceLine))
    .orderBy(asc(invoiceLine.invoiceId), asc(invoiceLine.position))
    .all()) {
    const list = linesOf.get(line.invoiceId);
    if (list) list.push(line);
    else linesOf.set(line.invoiceId, [line]);
  }

  for (const row of rows) {
    const label = `invoice ${row.id}`;
    const lines = linesOf.get(row.id) ?? [];
    problems.push(
      ...(row.external
        ? externalProblems(row, lines, label)
        : ownTotalsProblems(row, lines, label)),
    );

    problems.push(...rateProblems(row, label));
    if (!row.external && (row.importBatchId || row.importUuid || row.sourceSystem)) {
      problems.push(`${label}: vlastní doklad nese údaje importu`);
    }
    if (row.type === "invoice" && row.relatedInvoiceId) {
      problems.push(...finalProblems(row, byId, label));
    }
    if (row.status === "draft") {
      if (row.number !== null) problems.push(`${label}: koncept má číslo`);
      continue;
    }
    if (row.number === null) problems.push(`${label}: vystavený doklad nemá číslo`);
    if (!row.supplierSnapshot || !row.customerSnapshot) {
      problems.push(`${label}: vystavený doklad nemá snapshoty`);
    }
    if (!row.dateFormat) problems.push(`${label}: vystavený doklad nemá formát data`);
    if (row.paymentMethod === "transfer" && !row.accountSnapshot) {
      problems.push(`${label}: převod bez snapshotu účtu`);
    }
    if (row.type === "credit_note") problems.push(...creditNoteProblems(row, byId, label));
  }

  problems.push(...advanceProblems(rows));
  for (const row of rows) {
    if (row.supersededAt !== null && row.type !== "advance") {
      problems.push(`invoice ${row.id}: nahrazený doklad není záloha`);
    }
  }
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const row of rows) {
    if (row.number === null) continue;
    if (seen.has(row.number)) repeated.push(row.number);
    seen.add(row.number);
  }
  if (repeated.length > 0) problems.push(`invoice: opakovaná čísla ${repeated.join(", ")}`);
  return problems;
}

// A payment in a foreign currency is valid (PAY-006), so currency is checked through the credit:
// only a payment in the document currency must credit exactly what it says.
export function paymentProblems(q: Checker, ownerId: string): string[] {
  if (!ownerId) return [];
  const problems: string[] = [];
  const paidByInvoice = new Map(
    q
      .all<{ id: string; paid: number }>(
        sql`SELECT invoice_id AS id, sum(credited_minor) AS paid FROM payment
          WHERE user_id = ${ownerId} GROUP BY invoice_id`,
      )
      .map((row) => [row.id, row.paid]),
  );
  const rows = q.select().from(invoice).where(scoped(ownerId).where(invoice)).all();
  const byId: ById = new Map(rows.map((row) => [row.id, row]));
  const creditsOf = new Map<string, number>();
  for (const [id, notes] of relatedBy(
    rows,
    (row) => row.type === "credit_note" && isActiveDocument(row.status),
  )) {
    creditsOf.set(
      id,
      notes.reduce((sum, note) => sum + note.totalMinor, 0),
    );
  }
  for (const row of rows) {
    const label = `invoice ${row.id}`;
    const paid = paidByInvoice.get(row.id) ?? 0;
    if (row.paidMinor !== paid) problems.push(`${label}: paid_minor neodpovídá součtu plateb`);
    if (row.paidMinor < 0) problems.push(`${label}: paid_minor je záporné`);
    const creditsMinor = creditsOf.get(row.id) ?? 0;
    if (row.creditsMinor !== creditsMinor) {
      problems.push(`${label}: credits_minor neodpovídá aktivním opravám`);
    }
    const related = row.relatedInvoiceId ? byId.get(row.relatedInvoiceId) : undefined;
    const advanceMinor = related?.type === "advance" ? related.paidMinor : 0;
    // A cancelled final invoice is left out of balance updates until it is restored.
    if (row.status !== "cancelled" && row.advanceMinor !== advanceMinor) {
      problems.push(`${label}: advance_minor neodpovídá úhradě zálohy`);
    }
    const expected = deriveStatus({ ...row, paidMinor: paid, creditsMinor, advanceMinor });
    if (row.status !== expected) {
      problems.push(`${label}: stav ${row.status} neodpovídá platbám (${expected})`);
    }
  }

  const foreign = count(
    q,
    // The one join that crosses accounts on purpose: it is the check for exactly that.
    sql`SELECT count(*) AS n FROM payment p LEFT JOIN invoice i ON i.id = p.invoice_id
      WHERE (p.user_id = ${ownerId} OR i.user_id = ${ownerId})
        AND (i.id IS NULL OR i.user_id <> p.user_id)`,
  );
  if (foreign > 0) problems.push(`payment: ${foreign} plateb s cizím dokladem`);

  const miscredited = count(
    q,
    sql`SELECT count(*) AS n FROM payment p JOIN invoice i ON i.id = p.invoice_id
      WHERE p.user_id = ${ownerId} AND i.user_id = ${ownerId} AND p.currency = i.currency
        AND p.credited_minor <> p.amount_minor`,
  );
  if (miscredited > 0) problems.push(`payment: ${miscredited} plateb s jinou připsanou částkou`);

  const estimated = count(
    q,
    sql`SELECT count(*) AS n FROM payment p JOIN invoice i ON i.id = p.invoice_id
      WHERE p.user_id = ${ownerId} AND i.user_id = ${ownerId}
        AND ((p.date_estimated = 1 AND p.source <> 'import')
          OR (p.source = 'import' AND i.external = 0))`,
  );
  if (estimated > 0) problems.push(`payment: ${estimated} plateb s odhadem mimo import`);

  const noteRefunds = count(
    q,
    sql`SELECT count(*) AS n FROM payment p JOIN invoice i ON i.id = p.invoice_id
      WHERE p.user_id = ${ownerId} AND i.user_id = ${ownerId} AND i.type = 'credit_note'`,
  );
  if (noteRefunds > 0) problems.push(`payment: ${noteRefunds} plateb na opravné faktuře`);

  const unpayable = count(
    q,
    sql`SELECT count(*) AS n FROM invoice i
      WHERE i.user_id = ${ownerId} AND i.status IN ('draft', 'cancelled')
        AND EXISTS (SELECT 1 FROM payment p WHERE p.invoice_id = i.id AND p.user_id = ${ownerId})
        AND (i.status = 'draft' OR i.paid_minor <> 0)`,
  );
  // A cancelled document keeps the history of a fully refunded payment, never money.
  if (unpayable > 0)
    problems.push(`payment: ${unpayable} dokladů s platbou na konceptu nebo stornu`);
  return problems;
}

export function accountDataProblems(q: Checker, ownerId: string): string[] {
  return [...invoiceProblems(q, ownerId), ...paymentProblems(q, ownerId)];
}
