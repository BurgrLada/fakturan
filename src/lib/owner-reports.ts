import type { CalendarDate } from "./number-format";
import type { DateRange } from "./report-period";

export const PERIOD_SUMMARIES = ["off", "monthly", "quarterly"] as const;
export type PeriodSummaryMode = (typeof PERIOD_SUMMARIES)[number];
export type SummaryMode = Exclude<PeriodSummaryMode, "off">;

// A summary missed on the first day of its period still goes out until this day, then never (R-16).
export const CATCH_UP_DAYS = 3;

export type OwnerReportKind = "summary" | "tax" | "limit";

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_KEY = /^(\d{4})-Q([1-4])$/;
const DAY_MS = 86_400_000;

function iso(year: number, monthIndex: number, day: number): CalendarDate {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

// monthIndex may run past either end of the year; Date.UTC carries it over.
function span(year: number, monthIndex: number, months: number): DateRange {
  return { from: iso(year, monthIndex, 1), to: iso(year, monthIndex + months, 0) };
}

function keyOf(range: DateRange, mode: SummaryMode): string {
  const [year, month] = range.from.split("-").map(Number) as [number, number];
  if (mode === "monthly") return range.from.slice(0, 7);
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

export function finishedPeriod(
  today: CalendarDate,
  mode: SummaryMode,
): { key: string; range: DateRange; next: DateRange; dayOfPeriod: number } {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const months = mode === "monthly" ? 1 : 3;
  const start = mode === "monthly" ? month - 1 : Math.floor((month - 1) / 3) * 3;
  const next = span(year, start, months);
  const range = span(year, start - months, months);
  const dayOfPeriod = Math.round((Date.parse(today) - Date.parse(next.from)) / DAY_MS) + 1;
  return { key: keyOf(range, mode), range, next, dayOfPeriod };
}

export function periodOfKey(
  key: string,
): { mode: SummaryMode; range: DateRange; next: DateRange } | null {
  const monthly = MONTH_KEY.exec(key);
  if (monthly) {
    const [year, month] = [Number(monthly[1]), Number(monthly[2])];
    return { mode: "monthly", range: span(year, month - 1, 1), next: span(year, month, 1) };
  }
  const quarterly = QUARTER_KEY.exec(key);
  if (!quarterly) return null;
  const [year, start] = [Number(quarterly[1]), (Number(quarterly[2]) - 1) * 3];
  return { mode: "quarterly", range: span(year, start, 3), next: span(year, start + 3, 3) };
}
