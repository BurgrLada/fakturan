import { TEXTS } from "./texts";

export const DOCUMENT_TYPES = ["invoice", "advance", "credit_note"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const RESET_PERIODS = ["yearly", "quarterly", "monthly", "never"] as const;
export type ResetPeriod = (typeof RESET_PERIODS)[number];

// YYYY-MM-DD, the business date of a document (ARC-003); never derived through a Date in local time.
export type CalendarDate = string;

export const NUMBER_PRESETS: readonly { template: string; reset: ResetPeriod }[] = [
  { template: "{RRRR}-{NNN}", reset: "yearly" },
  { template: "{RRRR}-{NNNN}", reset: "yearly" },
  { template: "{RRRR}{NNN}", reset: "yearly" },
  { template: "{RR}{NNN}", reset: "yearly" },
  { template: "{RRRR}/{NNN}", reset: "yearly" },
  { template: "FV-{RRRR}-{NNN}", reset: "yearly" },
  { template: "{N}/{RRRR}", reset: "yearly" },
  { template: "{RRRR}{MM}{NNN}", reset: "monthly" },
];

const TOKEN = /\{(RRRR|RR|MM|DD|Q|N{1,6})\}/g;
const SEQUENCE = /\{N{1,6}\}/g;

function parseDate(date: CalendarDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [year, month, day] = (match ?? []).slice(1).map(Number);
  const probe = match ? new Date(Date.UTC(year!, month! - 1, day!)) : null;
  if (!probe || probe.getUTCMonth() !== month! - 1 || probe.getUTCDate() !== day!) {
    throw new Error(`${TEXTS.numberSeries.errors.invalidDate}: ${date}`);
  }
  return { year: match![1]!, month: match![2]!, day: match![3]!, quarter: Math.ceil(month! / 3) };
}

export function isCalendarDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

export function calendarDateInPrague(value: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function validateTemplate(template: string): string | null {
  if ((template.match(SEQUENCE) ?? []).length !== 1) return TEXTS.numberSeries.errors.oneSequence;
  if (/[{}]/.test(template.replace(TOKEN, ""))) return TEXTS.numberSeries.errors.unknownToken;
  return null;
}

// A counter that resets restarts at 1, so the template must carry the period or numbers repeat.
export function validateSeriesPeriod(template: string, reset: ResetPeriod): string | null {
  const has = (token: string) => template.includes(token);
  if (reset === "never") return null;
  if (!has("{RRRR}") && !has("{RR}")) return TEXTS.numberSeries.errors.needsYear;
  if (reset === "monthly" && !has("{MM}")) return TEXTS.numberSeries.errors.needsMonth;
  if (reset === "quarterly" && !has("{Q}") && !has("{MM}")) {
    return TEXTS.numberSeries.errors.needsQuarter;
  }
  return null;
}

export function formatNumber(template: string, date: CalendarDate, n: number): string {
  const { year, month, day, quarter } = parseDate(date);
  return template.replace(TOKEN, (_, token: string) => {
    if (token === "RRRR") return year;
    if (token === "RR") return year.slice(2);
    if (token === "MM") return month;
    if (token === "DD") return day;
    if (token === "Q") return String(quarter);
    return String(n).padStart(token.length, "0");
  });
}

export function previewNumber(template: string, date: CalendarDate, n: number): string | null {
  return validateTemplate(template) ? null : formatNumber(template, date, n);
}

export function periodKey(reset: ResetPeriod, date: CalendarDate): string {
  const { year, month, quarter } = parseDate(date);
  if (reset === "yearly") return year;
  if (reset === "quarterly") return `${year}-Q${quarter}`;
  if (reset === "monthly") return `${year}-${month}`;
  return "all";
}

export function variableSymbolFrom(number: string): string {
  return number.replace(/\D/g, "").slice(-10);
}
