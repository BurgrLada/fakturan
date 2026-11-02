import type { CalendarDate } from "./number-format";

export const PERIOD_TOKENS = [
  "this_month",
  "this_quarter",
  "this_year",
  "last_year",
  "last_30_days",
  "last_12_months",
] as const;
export type PeriodToken = (typeof PERIOD_TOKENS)[number];

export type DateRange = { from: CalendarDate; to: CalendarDate };
export type Period = PeriodToken | DateRange;

export const BUCKET_UNITS = ["day", "week", "month", "quarter", "year"] as const;
export type BucketUnit = (typeof BUCKET_UNITS)[number];

export type CompareMode = "previous" | "year";

const MS_PER_DAY = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Parts = { year: number; month: number; day: number };

function parts(date: CalendarDate): Parts {
  const match = DATE.exec(date);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day) {
      return { year, month, day };
    }
  }
  throw new RangeError(`Neplatné datum: ${date}`);
}

function format(value: Date): CalendarDate {
  return value.toISOString().slice(0, 10);
}

function dateOf(year: number, monthIndex: number, day: number): CalendarDate {
  return format(new Date(Date.UTC(year, monthIndex, day)));
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  return format(new Date(Date.parse(date) + days * MS_PER_DAY));
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// A day that the shorter month lacks, such as 29 February, falls back to the month's last day.
function shiftYears(date: CalendarDate, years: number): CalendarDate {
  const { year, month, day } = parts(date);
  return dateOf(year + years, month - 1, Math.min(day, lastDay(year + years, month)));
}

function quarterStart(month: number): number {
  return month - ((month - 1) % 3);
}

export function resolvePeriod(period: Period, today: CalendarDate): DateRange {
  if (typeof period === "object") {
    parts(period.from);
    parts(period.to);
    if (period.from > period.to) throw new RangeError("Období končí dřív, než začíná");
    return { from: period.from, to: period.to };
  }
  const { year, month } = parts(today);
  switch (period) {
    case "this_month":
      return { from: dateOf(year, month - 1, 1), to: dateOf(year, month, 0) };
    case "this_quarter": {
      const start = quarterStart(month);
      return { from: dateOf(year, start - 1, 1), to: dateOf(year, start + 2, 0) };
    }
    case "this_year":
      return { from: dateOf(year, 0, 1), to: dateOf(year, 11, 31) };
    case "last_year":
      return { from: dateOf(year - 1, 0, 1), to: dateOf(year - 1, 11, 31) };
    case "last_30_days":
      return { from: addDays(today, -29), to: today };
    case "last_12_months":
      return { from: addDays(shiftYears(today, -1), 1), to: today };
    default:
      throw new RangeError(`Neznámé období: ${String(period)}`);
  }
}

function monthIndex(date: CalendarDate): number {
  const { year, month } = parts(date);
  return year * 12 + month - 1;
}

function isWholeMonths(range: DateRange): boolean {
  const end = parts(range.to);
  return parts(range.from).day === 1 && end.day === lastDay(end.year, end.month);
}

// Whole months compare with the same number of whole months before them, so a quarter or a year
// gets the previous quarter or year; any other range with the same number of days.
export function previousRange(range: DateRange, mode: CompareMode): DateRange {
  if (mode === "year") return { from: shiftYears(range.from, -1), to: shiftYears(range.to, -1) };
  const to = addDays(range.from, -1);
  if (isWholeMonths(range)) {
    const months = monthIndex(range.to) - monthIndex(range.from) + 1;
    const { year, month } = parts(range.from);
    return { from: dateOf(year, month - 1 - months, 1), to };
  }
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / MS_PER_DAY);
  return { from: addDays(to, -days), to };
}

// ISO 8601: the week belongs to the year of its Thursday.
function isoWeek(date: CalendarDate): string {
  const value = new Date(Date.parse(date));
  const weekday = (value.getUTCDay() + 6) % 7;
  const thursday = new Date(value.getTime() + (3 - weekday) * MS_PER_DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * MS_PER_DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function bucketKey(date: CalendarDate, unit: BucketUnit): string {
  const { year, month } = parts(date);
  switch (unit) {
    case "day":
      return date;
    case "week":
      return isoWeek(date);
    case "month":
      return date.slice(0, 7);
    case "quarter":
      return `${year}-Q${Math.ceil(month / 3)}`;
    case "year":
      return String(year);
    default:
      throw new RangeError(`Neznámá jednotka: ${String(unit)}`);
  }
}

function nextBucket(date: CalendarDate, unit: BucketUnit): CalendarDate {
  const { year, month } = parts(date);
  if (unit === "day") return addDays(date, 1);
  if (unit === "week") return addDays(date, 7 - ((new Date(Date.parse(date)).getUTCDay() + 6) % 7));
  if (unit === "month") return dateOf(year, month, 1);
  if (unit === "quarter") return dateOf(year, quarterStart(month) + 2, 1);
  return dateOf(year + 1, 0, 1);
}

export function bucketsBetween(range: DateRange, unit: BucketUnit): string[] {
  const { from, to } = resolvePeriod(range, range.to);
  const keys: string[] = [];
  for (let day = from; day <= to; day = nextBucket(day, unit)) keys.push(bucketKey(day, unit));
  return keys;
}
