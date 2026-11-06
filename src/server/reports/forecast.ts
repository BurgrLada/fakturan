import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Currency } from "@/lib/currency";
import { addDays } from "@/lib/invoice";
import { occurrencesBetween } from "@/lib/recurrence";
import { fxCzk } from "@/lib/sql-functions";
import { isCalendarDate, type CalendarDate } from "@/lib/number-format";
import { dueSql, openCondition } from "../db/invoice-sql";
import { invoice, recurringInvoice } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "../services/access";
import { resolveRate } from "../services/exchange-rates";
import { totalsOf } from "../services/invoices";
import { planHeadColumns, ruleOf, type PlanHead } from "../services/recurring";
import type { SnapshotReader } from "./queries";
import type { Unconverted } from "./types";

export const FORECAST_SERIES = ["overdue", "open", "planned", "plannedDrafts", "advances"] as const;
export type ForecastSeries = (typeof FORECAST_SERIES)[number];

export type ForecastMonth = Record<ForecastSeries, number> & {
  month: string;
  unconverted: Record<ForecastSeries, Unconverted>;
};

export const FORECAST_MONTHS = 6;

type Missing = Map<ForecastSeries, Map<Currency, { count: number; amountMinor: number }>>;

const none = (): Unconverted => ({ count: 0, byCurrency: [] });

function monthKeys(today: CalendarDate, months: number): string[] {
  const [year, month] = today.split("-").map(Number) as [number, number];
  return Array.from({ length: months }, (_, index) => {
    const at = new Date(Date.UTC(year, month - 1 + index, 1));
    return at.toISOString().slice(0, 7);
  });
}

function occurrencesOf(q: Reader, plan: PlanHead, through: CalendarDate): CalendarDate[] {
  return occurrencesBetween(ruleOf(q, plan), plan.cursorDate, through).map((o) => o.issueDate);
}

function horizonEnd(today: CalendarDate, months: number): CalendarDate {
  const [year, month] = today.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1 + months, 0)).toISOString().slice(0, 10);
}

// Reads only and plans nothing: the plans and drafts are not touched, issuing stays with the scheduler.
export function forecast(
  q: SnapshotReader,
  ownerId: string,
  today: CalendarDate,
  months = FORECAST_MONTHS,
): ForecastMonth[] {
  if (!isCalendarDate(today)) throw new RangeError(`Neplatné datum: ${today}`);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    throw new RangeError(`Neplatný počet měsíců: ${months}`);
  }
  return q.transaction((tx: Reader) => forecastIn(tx, ownerId, today, months), {
    behavior: "deferred",
  });
}

// Late evening in Prague on `today`, after the CNB list is out: rates then follow the stored lists
// and `today` alone, never the hour the cached result happened to be computed at.
function rateMoment(today: CalendarDate): Date {
  return new Date(`${today}T20:00:00Z`);
}

function forecastIn(
  q: Reader,
  ownerId: string,
  today: CalendarDate,
  months: number,
): ForecastMonth[] {
  const keys = monthKeys(today, months);
  const now = rateMoment(today);
  const result: ForecastMonth[] = keys.map((month) => ({
    month,
    overdue: 0,
    open: 0,
    planned: 0,
    plannedDrafts: 0,
    advances: 0,
    unconverted: {
      overdue: none(),
      open: none(),
      planned: none(),
      plannedDrafts: none(),
      advances: none(),
    },
  }));
  const missing: Missing[] = keys.map(() => new Map());

  // A due date in the past or none at all is expected now; one beyond the horizon is not shown.
  function add(
    series: ForecastSeries,
    due: CalendarDate | null,
    currency: Currency,
    amountMinor: number,
    rateMicros: number | null,
  ) {
    const index = due === null || due < today ? 0 : keys.indexOf(due.slice(0, 7));
    if (index < 0) return;
    const czk = fxCzk(currency, amountMinor, rateMicros);
    if (czk === null) {
      const bySeries = missing[index]!.get(series) ?? new Map();
      const entry = bySeries.get(currency) ?? { count: 0, amountMinor: 0 };
      entry.count += 1;
      entry.amountMinor += amountMinor;
      bySeries.set(currency, entry);
      missing[index]!.set(series, bySeries);
      return;
    }
    result[index]![series] += Number(czk);
  }

  const rateMemo = new Map<string, number | null>();
  function rateOf(currency: Currency, date: CalendarDate): number | null {
    if (currency === "CZK") return null;
    const key = `${currency}:${date}`;
    if (!rateMemo.has(key)) {
      rateMemo.set(key, resolveRate(q, ownerId, currency, date, now)?.rateMicros ?? null);
    }
    return rateMemo.get(key)!;
  }

  const advance = alias(invoice, "advance");
  const documents = q
    .select({
      currency: invoice.currency,
      rateMicros: invoice.exchangeRateMicros,
      type: invoice.type,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      due: dueSql,
      totalMinor: invoice.totalMinor,
      advanceTotal: sql<number | null>`${advance.totalMinor} + ${advance.creditsMinor}`,
    })
    .from(invoice)
    .leftJoin(
      advance,
      and(
        eq(advance.id, invoice.relatedInvoiceId),
        eq(advance.type, "advance"),
        ne(advance.status, "cancelled"),
        scoped(ownerId).where(advance),
      ),
    )
    .where(
      scoped(ownerId).where(invoice, (t) =>
        or(
          openCondition,
          and(eq(t.status, "draft"), isNotNull(t.recurringId)),
          // The final invoice the advance automation (or the convert button) drafted: the rest
          // after the advance is expected, unlike a draft typed by hand (REP-007).
          and(eq(t.status, "draft"), eq(t.type, "invoice"), isNotNull(t.relatedInvoiceId)),
        ),
      ),
    )
    .all();
  for (const row of documents) {
    const isAdvance = row.type === "advance";
    if (row.status === "draft") {
      const rate = row.rateMicros ?? rateOf(row.currency, row.issueDate ?? today);
      // The advance itself stays in `advances` with what is still due on it, so a payment moves
      // money from one series to the other: the draft only adds what exceeds the whole advance.
      const remaining = Math.max(0, row.totalMinor - (row.advanceTotal ?? 0));
      add(isAdvance ? "advances" : "plannedDrafts", row.dueDate, row.currency, remaining, rate);
      continue;
    }
    const overdue = row.dueDate !== null && row.dueDate < today;
    const series = isAdvance ? "advances" : overdue ? "overdue" : "open";
    add(series, row.dueDate, row.currency, row.due, row.rateMicros);
  }

  const through = horizonEnd(today, months);
  // Heads first and each document on its own: a document may take up to STORED_JSON_BYTES and an
  // account up to ACCOUNT_ROW_LIMITS.recurring_invoice plans (I-3 of plan 9).
  const plans = q
    .select(planHeadColumns)
    .from(recurringInvoice)
    .where(scoped(ownerId).where(recurringInvoice, (t, { eq }) => eq(t.status, "active")))
    .all();
  for (const plan of plans) {
    const document = q
      .select({ document: recurringInvoice.document })
      .from(recurringInvoice)
      .where(scoped(ownerId).where(recurringInvoice, (t, { eq }) => eq(t.id, plan.id)))
      .get()?.document;
    if (!document) continue;
    const amountMinor = totalsOf(document.lines, document).totalMinor;
    const series = document.type === "advance" ? "advances" : "planned";
    for (const occurrence of occurrencesOf(q, plan, through)) {
      const due = addDays(occurrence, document.dueDays);
      add(series, due, document.currency, amountMinor, rateOf(document.currency, occurrence));
    }
  }

  result.forEach((month, index) => {
    for (const [series, byCurrency] of missing[index]!) {
      month.unconverted[series] = {
        count: [...byCurrency.values()].reduce((sum, entry) => sum + entry.count, 0),
        byCurrency: [...byCurrency]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, entry]) => ({ currency, amountMinor: entry.amountMinor })),
      };
    }
  });
  return result;
}
