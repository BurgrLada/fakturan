import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import { addDays } from "@/lib/invoice";
import { occurrencesBetween } from "@/lib/recurrence";
import { fxCzk } from "@/lib/sql-functions";
import { isCalendarDate, type CalendarDate } from "@/lib/number-format";
import { dueSql, openCondition } from "../db/invoice-sql";
import { invoice, recurringInvoice } from "../db/schema";
import { scoped } from "../db/scoped";
import { clock } from "../clock";
import type { Reader } from "../services/access";
import { resolveRate } from "../services/exchange-rates";
import { totalsOf } from "../services/invoices";
import { ruleOf } from "../services/recurring";
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

function occurrencesOf(
  q: Reader,
  plan: typeof recurringInvoice.$inferSelect,
  through: CalendarDate,
): CalendarDate[] {
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

function forecastIn(
  q: Reader,
  ownerId: string,
  today: CalendarDate,
  months: number,
): ForecastMonth[] {
  const keys = monthKeys(today, months);
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

  const documents = q
    .select({
      currency: invoice.currency,
      rateMicros: invoice.exchangeRateMicros,
      type: invoice.type,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      due: dueSql,
      draftRemaining: sql<number>`${invoice.totalMinor} - ${invoice.advanceMinor}`,
    })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        or(openCondition, and(eq(t.status, "draft"), isNotNull(t.recurringId))),
      ),
    )
    .all();
  for (const row of documents) {
    const advance = row.type === "advance";
    if (row.status === "draft") {
      const rate =
        row.rateMicros ??
        (row.currency === "CZK"
          ? null
          : (resolveRate(q, ownerId, row.currency, row.issueDate ?? today, clock.now())
              ?.rateMicros ?? null));
      add(
        advance ? "advances" : "plannedDrafts",
        row.dueDate,
        row.currency,
        row.draftRemaining,
        rate,
      );
      continue;
    }
    const overdue = row.dueDate !== null && row.dueDate < today;
    const series = advance ? "advances" : overdue ? "overdue" : "open";
    add(series, row.dueDate, row.currency, row.due, row.rateMicros);
  }

  const through = horizonEnd(today, months);
  const plans = q
    .select()
    .from(recurringInvoice)
    .where(scoped(ownerId).where(recurringInvoice, (t, { eq }) => eq(t.status, "active")))
    .all();
  for (const plan of plans) {
    const { document } = plan;
    const amountMinor = totalsOf(document.lines, document).totalMinor;
    const series = document.type === "advance" ? "advances" : "planned";
    for (const occurrence of occurrencesOf(q, plan, through)) {
      const due = addDays(occurrence, document.dueDays);
      const rate =
        document.currency === "CZK"
          ? null
          : (resolveRate(q, ownerId, document.currency, occurrence, clock.now())?.rateMicros ??
            null);
      add(series, due, document.currency, amountMinor, rate);
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
