import { isWorkingDay } from "./czech-holidays";
import { addDays } from "./invoice";
import { calendarDateInPrague, timeInPrague, type CalendarDate } from "./number-format";
import type { FxBasis } from "./preferences";

export const RATE_UNIT = 1_000_000;
export const MAX_EXCHANGE_RATE_MICROS = 1_000_000_000_000;
export const EXCHANGE_RATE_SOURCES = ["cnb", "last_known", "fixed", "manual"] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

const PUBLISHED_FROM = "14:30";
const ZERO = BigInt(0);
const TWO = BigInt(2);
const GAP_SCALE = BigInt(10_000);
const TOLERANCE = BigInt(500);
const RATE_TEXT = /^(\d{1,7})(?:,(\d{1,6}))?$/;

function assertRate(micros: number): void {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new RangeError("Neplatný kurz");
}

// Half away from zero, because a refund must mirror the payment it reverses.
function roundedQuotient(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < ZERO;
  const size = negative ? -numerator : numerator;
  const quotient = (TWO * size + denominator) / (TWO * denominator);
  return negative ? -quotient : quotient;
}

export function convertMinor(amountMinor: number, fromMicros: number, toMicros: number): number {
  assertRate(fromMicros);
  assertRate(toMicros);
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("Neplatná částka");
  const result = roundedQuotient(BigInt(amountMinor) * BigInt(fromMicros), BigInt(toMicros));
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Částka po převodu je příliš velká");
  }
  return Number(result);
}

export function toCzkMinor(amountMinor: number, rateMicros: number): number {
  return convertMinor(amountMinor, rateMicros, RATE_UNIT);
}

// A list quotes `amount` units of the currency; the stored rate is for one unit.
export function rateFromList(text: string, amount: number): number | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const match = RATE_TEXT.exec(text);
  if (!match) return null;
  const quoted = BigInt(match[1]!) * BigInt(RATE_UNIT) + BigInt((match[2] ?? "").padEnd(6, "0"));
  const perUnit = roundedQuotient(quoted, BigInt(amount));
  return perUnit > ZERO ? Number(perUnit) : null;
}

// The 5 % limit is inclusive: only a deviation above it is worth a warning (R-19).
export function deviationExceeds(rateMicros: number, referenceMicros: number): boolean {
  if (referenceMicros <= 0) return false;
  const gap = BigInt(Math.abs(rateMicros - referenceMicros));
  return gap * GAP_SCALE > TOLERANCE * BigInt(referenceMicros);
}

function lastWorkingDay(date: CalendarDate): CalendarDate {
  let day = date;
  while (!isWorkingDay(day)) day = addDays(day, -1);
  return day;
}

// CNB publishes on working days after 14:30, so today's list does not exist earlier. Days are
// Prague days, or a late evening in UTC would pick the wrong list.
export function expectedListDate(date: CalendarDate, now: Date): CalendarDate {
  const beforePublication =
    date === calendarDateInPrague(now) && timeInPrague(now) < PUBLISHED_FROM;
  return lastWorkingDay(beforePublication ? addDays(date, -1) : date);
}

export function rateDate(
  row: { issueDate: CalendarDate | null; taxableDate: CalendarDate | null },
  basis: FxBasis,
  today: CalendarDate,
): CalendarDate {
  if (basis === "taxable_date") return row.taxableDate ?? row.issueDate ?? today;
  return row.issueDate ?? today;
}

// A document in a foreign currency has no CZK value until it carries a rate (FOR-008).
export function documentCzkMinor(row: {
  currency: string;
  totalMinor: number;
  exchangeRateMicros: number | null;
}): number | null {
  if (row.currency === "CZK") return row.totalMinor;
  return row.exchangeRateMicros === null
    ? null
    : toCzkMinor(row.totalMinor, row.exchangeRateMicros);
}

export function paymentCzkMinor(row: {
  currency: string;
  amountMinor: number;
  rateMicros: number | null;
}): number | null {
  if (row.currency === "CZK") return row.amountMinor;
  return row.rateMicros === null ? null : toCzkMinor(row.amountMinor, row.rateMicros);
}
