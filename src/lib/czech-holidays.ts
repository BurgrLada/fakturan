import { addDays } from "./invoice";
import type { CalendarDate } from "./number-format";

const FIXED_HOLIDAYS = [
  "01-01",
  "05-01",
  "05-08",
  "07-05",
  "07-06",
  "09-28",
  "10-28",
  "11-17",
  "12-24",
  "12-25",
  "12-26",
];

// Anonymous Gregorian computus.
export function easterSunday(year: number): CalendarDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  const month = Math.floor(n / 31);
  const day = (n % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function czechHolidays(year: number): CalendarDate[] {
  const easter = easterSunday(year);
  return [
    ...FIXED_HOLIDAYS.map((day) => `${year}-${day}`),
    addDays(easter, -2),
    addDays(easter, 1),
  ].toSorted();
}

export function isoWeekday(date: CalendarDate): number {
  return new Date(Date.parse(date)).getUTCDay() || 7;
}

export function isWorkingDay(date: CalendarDate): boolean {
  return isoWeekday(date) <= 5 && !czechHolidays(Number(date.slice(0, 4))).includes(date);
}
