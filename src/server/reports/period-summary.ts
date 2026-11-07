import { and, count } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import type { CalendarDate } from "@/lib/number-format";
import type { DateRange } from "@/lib/report-period";
import type { Tx } from "../db";
import { overdueCondition } from "../db/invoice-sql";
import { invoice } from "../db/schema";
import type { Reader } from "../services/access";
import { forecast, FORECAST_SERIES } from "./forecast";
import { notAdvance, reportSummary, stateFilter, type SnapshotReader } from "./queries";
import type { ReportFilter, Unconverted } from "./types";

// The figures of the owner's period summary (REM-010), pure over a Reader like the rest of reports.

export type Money = { minor: number; unconverted: Unconverted };

export type PeriodSummary = {
  range: DateRange;
  next: DateRange;
  today: CalendarDate;
  invoiced: Money;
  income: Money;
  outstanding: Money;
  overdue: Money & { count: number };
  outlook: Money;
};

class Missing {
  private byCurrency = new Map<Currency, number>();
  private count = 0;

  add(unconverted: Unconverted): void {
    this.count += unconverted.count;
    for (const { currency, amountMinor } of unconverted.byCurrency) {
      this.byCurrency.set(currency, (this.byCurrency.get(currency) ?? 0) + amountMinor);
    }
  }

  get value(): Unconverted {
    return {
      count: this.count,
      byCurrency: [...this.byCurrency]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ currency, amountMinor })),
    };
  }
}

function monthIndex(month: string): number {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return year * 12 + number - 1;
}

// Every series of the forecast for the months of the next period. On the first days of a period
// today's month is its first month, so the forecast starts exactly there.
function outlookOf(q: Tx, ownerId: string, next: DateRange, today: CalendarDate): Money {
  const first = next.from.slice(0, 7);
  const last = next.to.slice(0, 7);
  const months = Math.max(1, monthIndex(last) - monthIndex(today.slice(0, 7)) + 1);
  const missing = new Missing();
  let minor = 0;
  for (const month of forecast(q, ownerId, today, months)) {
    if (month.month < first || month.month > last) continue;
    for (const series of FORECAST_SERIES) {
      minor += month[series];
      missing.add(month.unconverted[series]);
    }
  }
  return { minor, unconverted: missing.value };
}

// Counted like the overdue amount of reportSummary and the dashboard: advances stay out.
function overdueCount(
  q: Reader,
  ownerId: string,
  filter: ReportFilter,
  today: CalendarDate,
): number {
  const where = and(stateFilter(q, ownerId, filter), overdueCondition(today), notAdvance);
  return q.select({ n: count() }).from(invoice).where(where).get()?.n ?? 0;
}

// Flows follow the finished period; balances and the outlook are as of today (R-16). One read
// snapshot, so the overdue count cannot disagree with the overdue amount (M-5 of block C).
export function periodSnapshot(
  q: SnapshotReader,
  ownerId: string,
  range: DateRange,
  next: DateRange,
  today: CalendarDate,
): PeriodSummary {
  return q.transaction((tx: Tx) => summaryIn(tx, ownerId, range, next, today), {
    behavior: "deferred",
  });
}

function summaryIn(
  tx: Tx,
  ownerId: string,
  range: DateRange,
  next: DateRange,
  today: CalendarDate,
): PeriodSummary {
  const filter: ReportFilter = { range, includeExternal: true };
  const summary = reportSummary(tx, ownerId, filter, today);
  return {
    range,
    next,
    today,
    invoiced: { minor: summary.invoicedMinor, unconverted: summary.unconverted.invoiced },
    income: { minor: summary.incomeMinor, unconverted: summary.unconverted.income },
    outstanding: {
      minor: summary.outstandingMinor,
      unconverted: summary.unconverted.outstanding,
    },
    overdue: {
      count: overdueCount(tx, ownerId, filter, today),
      minor: summary.overdueMinor,
      unconverted: summary.unconverted.overdue,
    },
    outlook: outlookOf(tx, ownerId, next, today),
  };
}
