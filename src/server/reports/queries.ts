import { and, asc, desc, eq, gte, inArray, lte, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Currency } from "@/lib/currency";
import { daysBetween } from "@/lib/invoice";
import { isCalendarDate, type CalendarDate } from "@/lib/number-format";
import { bucketsBetween, resolvePeriod, type BucketUnit } from "@/lib/report-period";
import { dueSql, NOT_IN_TOTALS, openCondition, overdueCondition } from "../db/invoice-sql";
import { customer, exchangeRate, invoice, invoiceLine, payment } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Db, Tx } from "../db";
import type { Reader } from "../services/access";
import {
  AGING_BANDS,
  MAX_TOP_ROWS,
  type Aging,
  type AgingBand,
  type CurrencyShares,
  type PaymentDays,
  type RankedRow,
  type Ranking,
  type ReportFilter,
  type ReportSummary,
  type Series,
  type SummaryMetric,
  type Unconverted,
} from "./types";

// Pure over a Reader and free of server-only, so the consistency check of e2e runs can load it.

type Amount = SQL | SQLiteColumn;
export type SnapshotReader = Pick<Db | Tx, "select" | "transaction">;

const NOTHING: Unconverted = { count: 0, byCurrency: [] };
const DEFAULT_TOP_ROWS = 10;

const notAdvance = ne(invoice.type, "advance");
const outstanding = and(openCondition, notAdvance) as SQL;
const advanceOpen = and(openCondition, eq(invoice.type, "advance")) as SQL;

function checkFilter(filter: ReportFilter): void {
  resolvePeriod(filter.range, filter.range.to);
}

function checkToday(today: CalendarDate): void {
  if (!isCalendarDate(today)) throw new RangeError(`Neplatné datum: ${today}`);
}

const documentCzk = (amount: Amount): SQL =>
  sql`fx_czk(${invoice.currency}, ${amount}, ${invoice.exchangeRateMicros})`;

// Without a currency filter everything is in CZK; with one, amounts stay in that currency (R-8).
const documentMoney = (filter: ReportFilter, amount: Amount): SQL =>
  filter.currency ? sql`${amount}` : documentCzk(amount);

// A payment without its own rate takes the latest list from the week before (R-9).
const paymentRate = sql`coalesce(${payment.rateMicros}, (
  SELECT ${exchangeRate.rateMicros} FROM ${exchangeRate}
  WHERE ${exchangeRate.currency} = ${payment.currency}
    AND ${exchangeRate.listDate} <= ${payment.paidOn}
    AND ${exchangeRate.listDate} >= date(${payment.paidOn}, '-7 days')
  ORDER BY ${exchangeRate.listDate} DESC LIMIT 1))`;

const paymentMoney = (filter: ReportFilter): SQL =>
  filter.currency
    ? sql`${payment.amountMinor}`
    : sql`fx_czk(${payment.currency}, ${payment.amountMinor}, ${paymentRate})`;

const total = (value: SQL): SQL<number> => sql<number>`coalesce(sum(${value}), 0)`;
const totalWhen = (condition: SQL, value: SQL): SQL<number> =>
  sql<number>`coalesce(sum(CASE WHEN ${condition} THEN ${value} END), 0)`;

// A foreign or unknown ID never widens the filter: it leaves nothing to match.
function customerCondition(q: Reader, ownerId: string, ids: string[] | undefined): SQL | undefined {
  if (ids === undefined) return undefined;
  const owned =
    ids.length === 0
      ? []
      : q
          .select({ id: customer.id })
          .from(customer)
          .where(scoped(ownerId).where(customer, (t) => inArray(t.id, ids)))
          .all()
          .map((row) => row.id);
  return owned.length === 0 ? sql`0` : inArray(invoice.customerId, owned);
}

// Balances are the state as of today: the period never narrows them, the other filters do.
function stateFilter(q: Reader, ownerId: string, filter: ReportFilter): SQL {
  checkFilter(filter);
  const customers = customerCondition(q, ownerId, filter.customerIds);
  return scoped(ownerId).where(invoice, (t, { and, eq }) =>
    and(
      notInArray(t.status, NOT_IN_TOTALS),
      filter.currency ? eq(t.currency, filter.currency) : undefined,
      filter.includeExternal ? undefined : eq(t.external, false),
      customers,
    ),
  );
}

const issuedIn = (filter: ReportFilter): SQL =>
  and(gte(invoice.issueDate, filter.range.from), lte(invoice.issueDate, filter.range.to)) as SQL;

function documentFilter(q: Reader, ownerId: string, filter: ReportFilter): SQL {
  return and(stateFilter(q, ownerId, filter), issuedIn(filter)) as SQL;
}

// Both sides of the join belong to the account; the document decides the customer and import.
function paymentFilter(q: Reader, ownerId: string, filter: ReportFilter): SQL {
  checkFilter(filter);
  const customers = customerCondition(q, ownerId, filter.customerIds);
  return and(
    scoped(ownerId).where(payment, (t, { and, eq }) =>
      and(
        eq(t.kind, "payment"),
        gte(t.paidOn, filter.range.from),
        lte(t.paidOn, filter.range.to),
        filter.currency ? eq(t.currency, filter.currency) : undefined,
      ),
    ),
    scoped(ownerId).where(invoice, (t, { and, eq }) =>
      and(
        notInArray(t.status, NOT_IN_TOTALS),
        filter.includeExternal ? undefined : eq(t.external, false),
        customers,
      ),
    ),
  ) as SQL;
}

type UnconvertedRow = { currency: Currency; count: number; amountMinor: number };

function unconvertedOf(rows: UnconvertedRow[]): Unconverted {
  return {
    count: rows.reduce((sum, row) => sum + row.count, 0),
    byCurrency: rows.map(({ currency, amountMinor }) => ({ currency, amountMinor })),
  };
}

// `sum` skips NULL, so documents without a CZK value are counted here instead of vanishing (R-9).
function documentsUnconverted(q: Reader, where: SQL, amount: Amount, converted: boolean) {
  if (!converted) return NOTHING;
  const rows = q
    .select({
      currency: invoice.currency,
      count: sql<number>`count(*)`,
      amountMinor: total(sql`${amount}`),
    })
    .from(invoice)
    .where(and(where, sql`${documentCzk(amount)} IS NULL`))
    .groupBy(invoice.currency)
    .orderBy(asc(invoice.currency))
    .all();
  return unconvertedOf(rows);
}

function paymentsUnconverted(q: Reader, where: SQL, filter: ReportFilter): Unconverted {
  if (filter.currency) return NOTHING;
  const rows = q
    .select({
      currency: payment.currency,
      count: sql<number>`count(*)`,
      amountMinor: total(sql`${payment.amountMinor}`),
    })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(and(where, sql`${paymentMoney(filter)} IS NULL`))
    .groupBy(payment.currency)
    .orderBy(asc(payment.currency))
    .all();
  return unconvertedOf(rows);
}

type DocumentMetric = Exclude<SummaryMetric, "income">;

// One pass over the documents: per currency, what each balance or flow is missing.
function summaryUnconverted(
  q: Reader,
  where: SQL,
  metrics: Record<DocumentMetric, { condition: SQL; amount: Amount }>,
  converted: boolean,
): Record<DocumentMetric, Unconverted> {
  const names = Object.keys(metrics) as DocumentMetric[];
  if (!converted) return Object.fromEntries(names.map((name) => [name, NOTHING])) as never;
  const missing = sql`${documentCzk(invoice.totalMinor)} IS NULL`;
  const columns = Object.fromEntries(
    names.flatMap((name) => {
      const { condition, amount } = metrics[name];
      const when = sql`${condition} AND ${missing}`;
      return [
        [`${name}Count`, totalWhen(when, sql`1`)],
        [`${name}Amount`, totalWhen(when, sql`${amount}`)],
      ];
    }),
  ) as Record<string, SQL<number>>;
  const rows = q
    .select({ currency: invoice.currency, ...columns })
    .from(invoice)
    .where(and(where, missing))
    .groupBy(invoice.currency)
    .orderBy(asc(invoice.currency))
    .all() as ({ currency: Currency } & Record<string, number>)[];
  return Object.fromEntries(
    names.map((name) => [
      name,
      unconvertedOf(
        rows
          .filter((row) => row[`${name}Count`]! > 0)
          .map((row) => ({
            currency: row.currency,
            count: row[`${name}Count`]!,
            amountMinor: row[`${name}Amount`]!,
          })),
      ),
    ]),
  ) as Record<DocumentMetric, Unconverted>;
}

// One deferred read transaction, so sums and missing rates come from the same WAL snapshot.
export function reportSummary(
  q: SnapshotReader,
  ownerId: string,
  filter: ReportFilter,
  today: CalendarDate,
): ReportSummary {
  checkToday(today);
  return q.transaction((tx: Reader) => summaryIn(tx, ownerId, filter, today), {
    behavior: "deferred",
  });
}

function summaryIn(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  today: CalendarDate,
): ReportSummary {
  const where = stateFilter(q, ownerId, filter);
  const money = (amount: Amount) => documentMoney(filter, amount);
  const metrics = {
    invoiced: { condition: and(notAdvance, issuedIn(filter)) as SQL, amount: invoice.totalMinor },
    outstanding: { condition: outstanding, amount: dueSql },
    overdue: { condition: and(overdueCondition(today), notAdvance) as SQL, amount: dueSql },
    advanceOpen: { condition: advanceOpen, amount: dueSql },
  };
  const documents = q
    .select({
      invoicedMinor: totalWhen(metrics.invoiced.condition, money(invoice.totalMinor)),
      outstandingMinor: totalWhen(outstanding, money(dueSql)),
      overdueMinor: totalWhen(metrics.overdue.condition, money(dueSql)),
      advanceOpenMinor: totalWhen(advanceOpen, money(dueSql)),
    })
    .from(invoice)
    .where(where)
    .get()!;
  const payments = paymentFilter(q, ownerId, filter);
  const { incomeMinor } = q
    .select({ incomeMinor: total(paymentMoney(filter)) })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(payments)
    .get()!;
  const missing = summaryUnconverted(q, where, metrics, !filter.currency);
  return {
    ...documents,
    incomeMinor,
    unconverted: {
      invoiced: missing.invoiced,
      income: paymentsUnconverted(q, payments, filter),
      outstanding: missing.outstanding,
      overdue: missing.overdue,
      advanceOpen: missing.advanceOpen,
    },
  };
}

function filled(keys: string[], rows: { key: string | null; amountMinor: number }[]) {
  const amounts = new Map(rows.map((row) => [row.key, row.amountMinor]));
  return keys.map((key) => ({ key, amountMinor: amounts.get(key) ?? 0 }));
}

// Empty buckets are zero, so a chart never skips a month without documents (R-12).
export function invoicedSeries(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  unit: BucketUnit,
): Series {
  const keys = bucketsBetween(filter.range, unit);
  const where = and(documentFilter(q, ownerId, filter), notAdvance) as SQL;
  const key = sql<string | null>`date_bucket(${invoice.issueDate}, ${unit})`;
  const rows = q
    .select({ key, amountMinor: total(documentMoney(filter, invoice.totalMinor)) })
    .from(invoice)
    .where(where)
    .groupBy(key)
    .all();
  return {
    points: filled(keys, rows),
    unconverted: documentsUnconverted(q, where, invoice.totalMinor, !filter.currency),
  };
}

export function incomeSeries(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  unit: BucketUnit,
): Series {
  const keys = bucketsBetween(filter.range, unit);
  const where = paymentFilter(q, ownerId, filter);
  const key = sql<string | null>`date_bucket(${payment.paidOn}, ${unit})`;
  const rows = q
    .select({ key, amountMinor: total(paymentMoney(filter)) })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(where)
    .groupBy(key)
    .all();
  return { points: filled(keys, rows), unconverted: paymentsUnconverted(q, where, filter) };
}

// A balance as of today, so the period does not narrow it. Age is today - due date. A document due today or later, or without a due date, is not overdue
// yet, so the four bands of REP-002 add up to overdueMinor exactly (R-11).
export function agingBands(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  today: CalendarDate,
): Aging {
  checkToday(today);
  const where = and(stateFilter(q, ownerId, filter), outstanding) as SQL;
  const age = sql`CAST(julianday(${today}) - julianday(${invoice.dueDate}) AS INTEGER)`;
  const band = sql<AgingBand>`CASE
    WHEN ${invoice.dueDate} IS NULL OR ${invoice.dueDate} >= ${today} THEN 'current'
    WHEN ${age} <= 30 THEN 'days0to30'
    WHEN ${age} <= 60 THEN 'days31to60'
    WHEN ${age} <= 90 THEN 'days61to90'
    ELSE 'days90plus' END`;
  const rows = q
    .select({ band, amountMinor: total(documentMoney(filter, dueSql)) })
    .from(invoice)
    .where(where)
    .groupBy(band)
    .all();
  const bands = Object.fromEntries(AGING_BANDS.map((name) => [name, 0])) as Record<
    AgingBand,
    number
  >;
  for (const row of rows) bands[row.band] = row.amountMinor;
  return { bands, unconverted: documentsUnconverted(q, where, dueSql, !filter.currency) };
}

function ranked(rows: Omit<RankedRow, "kind">[], limit: number): RankedRow[] {
  const size = Math.min(MAX_TOP_ROWS, Math.max(1, Math.floor(limit)));
  const top: RankedRow[] = rows.slice(0, size).map((row) => ({ kind: "row", ...row }));
  const rest = rows.slice(size);
  if (rest.length === 0) return top;
  const amountMinor = rest.reduce((sum, row) => sum + row.amountMinor, 0);
  return [...top, { kind: "others", key: "others", name: "", amountMinor }];
}

export function topCustomers(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  limit = DEFAULT_TOP_ROWS,
): Ranking {
  const where = and(documentFilter(q, ownerId, filter), notAdvance) as SQL;
  const value = documentMoney(filter, invoice.totalMinor);
  const amountMinor = total(value);
  const name = sql<string>`max(${invoice.customerName})`;
  const rows = q
    .select({ key: sql<string>`coalesce(${invoice.customerId}, '')`, name, amountMinor })
    .from(invoice)
    .where(where)
    .groupBy(invoice.customerId)
    .having(sql`count(${value}) > 0`)
    .orderBy(desc(amountMinor), asc(name))
    .all();
  return {
    rows: ranked(rows, limit),
    unconverted: documentsUnconverted(q, where, invoice.totalMinor, !filter.currency),
  };
}

// Lines do not carry the document discount or rounding, so the table ends with the difference
// against the invoiced amount and always adds up to it (R-10). Advances would count items twice.
export function topItems(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  limit = DEFAULT_TOP_ROWS,
): Ranking {
  const where = and(documentFilter(q, ownerId, filter), notAdvance) as SQL;
  const value = documentMoney(filter, invoiceLine.netMinor);
  const amountMinor = total(value);
  const key = sql<string>`coalesce('item:' || ${invoiceLine.catalogItemId}, 'name:' || ${invoiceLine.name})`;
  const name = sql<string>`max(${invoiceLine.name})`;
  const rows = q
    .select({ key, name, amountMinor })
    .from(invoiceLine)
    .innerJoin(invoice, eq(invoice.id, invoiceLine.invoiceId))
    .where(and(scoped(ownerId).where(invoiceLine), where))
    .groupBy(key)
    .having(sql`count(${value}) > 0`)
    .orderBy(desc(amountMinor), asc(name))
    .all();
  const { invoicedMinor } = q
    .select({ invoicedMinor: total(documentMoney(filter, invoice.totalMinor)) })
    .from(invoice)
    .where(where)
    .get()!;
  const adjustment = invoicedMinor - rows.reduce((sum, row) => sum + row.amountMinor, 0);
  const result = ranked(rows, limit);
  if (adjustment !== 0) {
    result.push({ kind: "adjustment", key: "adjustment", name: "", amountMinor: adjustment });
  }
  return {
    rows: result,
    unconverted: documentsUnconverted(q, where, invoice.totalMinor, !filter.currency),
  };
}

// Shares compare currencies, so they are always weighed in CZK even under a currency filter.
export function currencyShares(q: Reader, ownerId: string, filter: ReportFilter): CurrencyShares {
  const where = and(documentFilter(q, ownerId, filter), notAdvance) as SQL;
  const czk = documentCzk(invoice.totalMinor);
  const rows = q
    .select({
      currency: invoice.currency,
      amountMinor: totalWhen(sql`${czk} IS NOT NULL`, sql`${invoice.totalMinor}`),
      czkMinor: total(czk),
    })
    .from(invoice)
    .where(where)
    .groupBy(invoice.currency)
    .having(sql`count(${czk}) > 0`)
    .orderBy(asc(invoice.currency))
    .all();
  return { rows, unconverted: documentsUnconverted(q, where, invoice.totalMinor, true) };
}

// A closed difference says nothing about how fast the client paid, so its document stays out
// (R-23). The period is the day of the last payment.
export function paymentDays(q: Reader, ownerId: string, filter: ReportFilter): PaymentDays {
  checkFilter(filter);
  const customers = customerCondition(q, ownerId, filter.customerIds);
  const rows = q
    .select({
      issueDate: invoice.issueDate,
      lastPaidOn: sql<
        string | null
      >`max(CASE WHEN ${payment.kind} = 'payment' AND ${payment.creditedMinor} > 0 THEN ${payment.paidOn} END)`,
      differences: sql<number>`sum(CASE WHEN ${payment.kind} = 'difference' THEN 1 ELSE 0 END)`,
    })
    .from(payment)
    .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
    .where(
      and(
        scoped(ownerId).where(payment),
        scoped(ownerId).where(invoice, (t, { and, eq }) =>
          and(
            eq(t.status, "paid"),
            filter.currency ? eq(t.currency, filter.currency) : undefined,
            filter.includeExternal ? undefined : eq(t.external, false),
            customers,
          ),
        ),
      ),
    )
    .groupBy(invoice.id)
    .all();
  const { from, to } = filter.range;
  const days = rows.flatMap(({ issueDate, lastPaidOn, differences }) =>
    issueDate && lastPaidOn && differences === 0 && lastPaidOn >= from && lastPaidOn <= to
      ? [daysBetween(issueDate, lastPaidOn)]
      : [],
  );
  if (days.length === 0) return { averageDays: null, count: 0 };
  return { averageDays: days.reduce((sum, d) => sum + d, 0) / days.length, count: days.length };
}
