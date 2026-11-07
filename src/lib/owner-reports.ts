import type { CalendarDate } from "./number-format";
import type { DateRange } from "./report-period";
import { LIMIT_HIGH_PERCENT, LIMIT_WARN_PERCENT, type LimitLevel } from "./turnover-limits";

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

// January 10 for the previous year, with a catch-up to the end of the month (R-16).
const TAX_REMINDER_FROM_DAY = 10;

export function taxReminderDue(today: CalendarDate): { year: number } | null {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  return month === 1 && day >= TAX_REMINDER_FROM_DAY ? { year: year - 1 } : null;
}

// In rising order; a job key and the lasting record end with the threshold (R-15, M-1 of block C).
export const LIMIT_MAIL_THRESHOLDS = [LIMIT_WARN_PERCENT, LIMIT_HIGH_PERCENT, "over"] as const;
export type LimitMailThreshold = (typeof LIMIT_MAIL_THRESHOLDS)[number];

export function limitMailThreshold(level: LimitLevel): LimitMailThreshold | null {
  if (level === "warn") return LIMIT_WARN_PERCENT;
  if (level === "high") return LIMIT_HIGH_PERCENT;
  if (level === "over") return "over";
  return null;
}

// The thresholds a crossing of `threshold` settles without a message of their own.
export function lowerThresholds(threshold: LimitMailThreshold): LimitMailThreshold[] {
  return LIMIT_MAIL_THRESHOLDS.slice(0, LIMIT_MAIL_THRESHOLDS.indexOf(threshold));
}

// A late document with a December date of supply, or a payment recorded late, still moves the
// previous year, so January looks at both (I-1 of block C).
export function limitYears(today: CalendarDate): number[] {
  const [year, month] = today.split("-").map(Number) as [number, number];
  return month === 1 ? [year, year - 1] : [year];
}
