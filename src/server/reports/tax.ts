import { and, asc, eq, inArray, lte, notInArray, sql, type SQL } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import { documentCzkMinor } from "@/lib/fx";
import { ACTIVE_CREDIT_STATUSES, type InvoiceType } from "@/lib/invoice";
import { isCalendarDate, type CalendarDate } from "@/lib/number-format";
import type { TaxBasis, TaxFilter } from "@/lib/report-filter";
import { NOT_IN_TOTALS } from "../db/invoice-sql";
import { invoice, payment } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "../services/access";
import {
  documentFilter,
  documentMoney,
  notAdvance,
  paymentFilter,
  paymentMoney,
  type SnapshotReader,
} from "./queries";
import type { ReportFilter, Unconverted } from "./types";

// Pure over a Reader and free of server-only like queries.ts: the e2e consistency check loads it.

export type TaxLine = {
  invoiceId: string;
  date: CalendarDate;
  number: string;
  type: InvoiceType;
  customer: string;
  currency: Currency;
  amountMinor: number;
  czkMinor: number | null;
  estimated: boolean;
  // The other half of an advance pair, so a reader sees why a final invoice adds nothing (ADV-005).
  related: { role: "final" | "advance"; number: string | null } | null;
};

export type UnpaidRow = {
  invoiceId: string;
  number: string;
  type: InvoiceType;
  issueDate: CalendarDate;
  dueDate: CalendarDate | null;
  customer: string;
  currency: Currency;
  dueMinor: number;
  czkMinor: number | null;
};

// The page shows this many rows of each table; the totals cover all of them and the full list is in
// the Excel and CSV exports. Without it a year of a large or restored account would be one page
// of hundreds of MiB, held again by the cache, the RSC payload and the HTML (plan 9).
export const TAX_PAGE_ROWS = 2_000;

export type TaxPage = TaxOverview & { linesCount: number; unpaidCount: number };

export function taxPage(overview: TaxOverview, rows = TAX_PAGE_ROWS): TaxPage {
  return {
    ...overview,
    lines: overview.lines.slice(0, rows),
    unpaid: overview.unpaid.slice(0, rows),
    linesCount: overview.lines.length,
    unpaidCount: overview.unpaid.length,
  };
}

export type TaxOverview = {
  year: number;
  basis: TaxBasis;
  lines: TaxLine[];
  totalCzkMinor: number;
  unpaid: UnpaidRow[];
  unpaidCzkMinor: number;
  unpaidUnconverted: Unconverted;
  estimated: { count: number; czkMinor: number };
  unconverted: Unconverted;
  asOf: CalendarDate;
  asOfToday: boolean;
};

// R-26: imported documents count like any other, so the shared filters run with includeExternal.
const yearFilter = (year: number): ReportFilter => ({
  range: { from: `${year}-01-01`, to: `${year}-12-31` },
  includeExternal: true,
});

function unconvertedOf(rows: { currency: Currency; amountMinor: number; czk: number | null }[]) {
  const byCurrency = new Map<Currency, number>();
  let count = 0;
  for (const row of rows) {
    if (row.czk !== null) continue;
    count += 1;
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amountMinor);
  }
  return {
    count,
    byCurrency: [...byCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amountMinor]) => ({ currency, amountMinor })),
  };
}

// Drizzle leaves columns of a one-table select unqualified, and inside a subquery such a name would
// bind to the inner table; the outer document is therefore named explicitly.
const outer = (column: "id" | "related_invoice_id" | "type") => sql.raw(`"invoice"."${column}"`);

// The final invoice of an advance, or the advance of a final invoice, both inside the account.
function relatedNumber(ownerId: string, role: "final" | "advance"): SQL<string | null> {
  return role === "final"
    ? sql<string | null>`(SELECT f.number FROM invoice AS f
        WHERE f.user_id = ${ownerId} AND f.related_invoice_id = ${outer("id")}
          AND f.type = 'invoice' AND f.status NOT IN ('draft', 'cancelled')
        ORDER BY f.issue_date, f.number, f.id LIMIT 1)`
    : sql<string | null>`(SELECT a.number FROM invoice AS a
        WHERE a.user_id = ${ownerId} AND a.id = ${outer("related_invoice_id")}
          AND a.type = 'advance' LIMIT 1)`;
}

// R-26: every payment and refund of the year, the advance paid in it included, in CZK of its day.
function paidLines(q: Reader, ownerId: string, year: number): TaxLine[] {
  const filter = yearFilter(year);
  const rows = q
    .select({
      invoiceId: invoice.id,
      date: payment.paidOn,
      number: invoice.number,
      type: invoice.type,
      customer: invoice.customerName,
      currency: payment.currency,
      amountMinor: payment.amountMinor,
      czkMinor: sql<number | null>`${paymentMoney(filter)}`,
      estimated: payment.dateEstimated,
      finalNumber: relatedNumber(ownerId, "final"),
      advanceNumber: relatedNumber(ownerId, "advance"),
      relatedId: invoice.relatedInvoiceId,
    })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(paymentFilter(q, ownerId, filter))
    .orderBy(asc(payment.paidOn), asc(invoice.number), asc(payment.id))
    .all();
  return rows.map(({ finalNumber, advanceNumber, relatedId, ...row }) => ({
    ...row,
    number: row.number ?? "",
    related:
      row.type === "advance"
        ? { role: "final", number: finalNumber }
        : row.type === "invoice" && relatedId && advanceNumber
          ? { role: "advance", number: advanceNumber }
          : null,
  }));
}

// R-27: documents issued in the year, corrections negative, the final invoice whole, never an advance.
function issuedLines(q: Reader, ownerId: string, year: number): TaxLine[] {
  const filter = yearFilter(year);
  const rows = q
    .select({
      invoiceId: invoice.id,
      date: sql<CalendarDate>`${invoice.issueDate}`,
      number: invoice.number,
      type: invoice.type,
      customer: invoice.customerName,
      currency: invoice.currency,
      amountMinor: invoice.totalMinor,
      czkMinor: sql<number | null>`${documentMoney(filter, invoice.totalMinor)}`,
      advanceNumber: relatedNumber(ownerId, "advance"),
    })
    .from(invoice)
    .where(and(documentFilter(q, ownerId, filter), notAdvance))
    .orderBy(asc(invoice.issueDate), asc(invoice.number), asc(invoice.id))
    .all();
  return rows.map(({ advanceNumber, ...row }) => ({
    ...row,
    number: row.number ?? "",
    estimated: false,
    related: advanceNumber ? { role: "advance", number: advanceNumber } : null,
  }));
}

const CREDIT_STATUSES = sql.raw(ACTIVE_CREDIT_STATUSES.map((status) => `'${status}'`).join(", "));

// R-28: dueSql is today's balance, so the state on a past day is rebuilt from history: payments,
// corrections and the paid advance up to that day. A later cancellation hides the document, the
// cancellation itself carries no date.
export function unpaidAsOf(q: Reader, ownerId: string, date: CalendarDate): UnpaidRow[] {
  if (!isCalendarDate(date)) throw new RangeError(`Neplatné datum: ${date}`);
  const credits = sql<number>`(SELECT coalesce(sum(n.total_minor), 0) FROM invoice AS n
    WHERE n.user_id = ${ownerId} AND n.type = 'credit_note' AND n.related_invoice_id = ${outer("id")}
      AND n.status IN (${CREDIT_STATUSES}) AND n.issue_date <= ${date})`;
  const paid = sql<number>`(SELECT coalesce(sum(p.credited_minor), 0) FROM payment AS p
    WHERE p.user_id = ${ownerId} AND p.invoice_id = ${outer("id")} AND p.paid_on <= ${date})`;
  const advance = sql<number>`CASE WHEN ${outer("type")} = 'invoice' THEN (
    SELECT coalesce(sum(p.credited_minor), 0) FROM payment AS p
    JOIN invoice AS a ON a.id = p.invoice_id AND a.user_id = ${ownerId}
    WHERE p.user_id = ${ownerId} AND a.id = ${outer("related_invoice_id")} AND a.type = 'advance'
      AND p.paid_on <= ${date}) ELSE 0 END`;
  const rows = q
    .select({
      invoiceId: invoice.id,
      number: invoice.number,
      type: invoice.type,
      issueDate: sql<CalendarDate>`${invoice.issueDate}`,
      dueDate: invoice.dueDate,
      customer: invoice.customerName,
      currency: invoice.currency,
      exchangeRateMicros: invoice.exchangeRateMicros,
      dueMinor: sql<number>`${invoice.totalMinor} + ${credits} - ${advance} - ${paid}`,
    })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        and(
          notInArray(t.status, NOT_IN_TOTALS),
          inArray(t.type, ["invoice", "credit_note"]),
          lte(t.issueDate, date),
        ),
      ),
    )
    .orderBy(asc(invoice.issueDate), asc(invoice.number), asc(invoice.id))
    .all();
  return rows
    .filter((row) => row.dueMinor > 0)
    .map(({ exchangeRateMicros, ...row }) => ({
      ...row,
      number: row.number ?? "",
      czkMinor: documentCzkMinor({
        currency: row.currency,
        totalMinor: row.dueMinor,
        exchangeRateMicros,
      }),
    }));
}

const sumCzk = (values: (number | null)[]) => values.reduce<number>((sum, v) => sum + (v ?? 0), 0);

// One deferred read transaction, so the lines, the sum and the balances come from one snapshot.
export function taxOverview(
  q: SnapshotReader,
  ownerId: string,
  { year, basis }: TaxFilter,
  today: CalendarDate,
): TaxOverview {
  if (!isCalendarDate(today)) throw new RangeError(`Neplatné datum: ${today}`);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new RangeError(`Neplatný rok: ${year}`);
  }
  const yearEnd = `${year}-12-31`;
  const asOfToday = yearEnd >= today;
  const asOf = asOfToday ? today : yearEnd;
  return q.transaction(
    (tx: Reader) => {
      const lines =
        basis === "paid" ? paidLines(tx, ownerId, year) : issuedLines(tx, ownerId, year);
      const unpaid = unpaidAsOf(tx, ownerId, asOf);
      const estimated = lines.filter((line) => line.estimated);
      return {
        year,
        basis,
        lines,
        totalCzkMinor: sumCzk(lines.map((line) => line.czkMinor)),
        unpaid,
        unpaidCzkMinor: sumCzk(unpaid.map((row) => row.czkMinor)),
        unpaidUnconverted: unconvertedOf(
          unpaid.map((row) => ({ ...row, amountMinor: row.dueMinor, czk: row.czkMinor })),
        ),
        estimated: {
          count: estimated.length,
          czkMinor: sumCzk(estimated.map((line) => line.czkMinor)),
        },
        unconverted: unconvertedOf(lines.map((line) => ({ ...line, czk: line.czkMinor }))),
        asOf,
        asOfToday,
      };
    },
    { behavior: "deferred" },
  );
}
