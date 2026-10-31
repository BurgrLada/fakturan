import { isoWeekday, isWorkingDay } from "./czech-holidays";
import { addDays } from "./invoice";
import { isCalendarDate, type CalendarDate } from "./number-format";
import { monthPeriod, type VariablePeriod } from "./template-vars";

export const RECURRENCE_FREQUENCIES = [
  "weekly",
  "monthly",
  "quarterly",
  "half_yearly",
  "yearly",
  "every_weeks",
  "every_months",
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const ISSUE_RULES = ["day", "period_end", "first_working_day", "last_working_day"] as const;
export type IssueRule = (typeof ISSUE_RULES)[number];

export type RecurrenceRule = {
  frequency: RecurrenceFrequency;
  every: number;
  issueRule: IssueRule;
  issueDay: number | null;
  startsOn: CalendarDate;
  endsOn: CalendarDate | null;
  maxCount: number | null;
  periodOffset: number;
};

export type Occurrence = {
  index: number;
  periodKey: string;
  issueDate: CalendarDate;
  schedulePeriod: VariablePeriod;
  billedPeriod: VariablePeriod;
};

const MAX_EVERY: Record<RecurrenceFrequency, number> = {
  weekly: 1,
  monthly: 1,
  quarterly: 1,
  half_yearly: 1,
  yearly: 1,
  every_weeks: 52,
  every_months: 24,
};

const MONTHS_PER_UNIT = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12, every_months: 1 };

const MAX_PERIOD_OFFSET = 12;

const LAST_DATE: CalendarDate = "2100-12-31";

function isWeekBased(frequency: RecurrenceFrequency): frequency is "weekly" | "every_weeks" {
  return frequency === "weekly" || frequency === "every_weeks";
}

function isIntegerBetween(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isValidIssueDay({ frequency, issueRule, issueDay }: RecurrenceRule) {
  if (issueRule !== "day") return issueDay === null;
  return issueDay !== null && isIntegerBetween(issueDay, 1, isWeekBased(frequency) ? 7 : 31);
}

function isDateInRange(date: CalendarDate) {
  return isCalendarDate(date) && date <= LAST_DATE;
}

// Returns the names of invalid fields. The bounds also guarantee that every computation below ends.
export function validateRule(rule: RecurrenceRule): string[] {
  const { frequency, every, issueRule, startsOn, endsOn, maxCount, periodOffset } = rule;
  const validFrequency = RECURRENCE_FREQUENCIES.includes(frequency);
  const validStart = isDateInRange(startsOn);
  const invalid: [string, boolean][] = [
    ["frequency", !validFrequency],
    ["every", validFrequency && !isIntegerBetween(every, 1, MAX_EVERY[frequency])],
    ["issueRule", !ISSUE_RULES.includes(issueRule)],
    ["issueDay", ISSUE_RULES.includes(issueRule) && !isValidIssueDay(rule)],
    ["startsOn", !validStart],
    ["endsOn", endsOn !== null && (!isDateInRange(endsOn) || (validStart && endsOn < startsOn))],
    ["maxCount", maxCount !== null && !isIntegerBetween(maxCount, 1, Number.MAX_SAFE_INTEGER)],
    ["periodOffset", !isIntegerBetween(periodOffset, -MAX_PERIOD_OFFSET, MAX_PERIOD_OFFSET)],
  ];
  const fields = invalid.filter(([, isInvalid]) => isInvalid).map(([field]) => field);
  if (fields.length === 0 && endsOn !== null && firstIssueDate(rule) > endsOn) return ["endsOn"];
  return fields;
}

function absoluteMonth(date: CalendarDate) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function firstOfMonth(monthIndex: number): CalendarDate {
  const year = String(Math.floor(monthIndex / 12)).padStart(4, "0");
  const month = String((monthIndex % 12) + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

// Weeks and "every N" blocks count from the week or month of the start, the rest is calendar-aligned.
// `n` may be negative, which is how a negative offset reaches before the start.
function periodAt({ frequency, every, startsOn }: RecurrenceRule, n: number): VariablePeriod {
  if (isWeekBased(frequency)) {
    const days = 7 * every;
    const from = addDays(addDays(startsOn, 1 - isoWeekday(startsOn)), n * days);
    return { from, to: addDays(from, days - 1) };
  }
  const unit = MONTHS_PER_UNIT[frequency];
  const months = unit * every;
  const first = Math.floor(absoluteMonth(startsOn) / unit) * unit + n * months;
  return { from: firstOfMonth(first), to: monthPeriod(firstOfMonth(first + months - 1)).to };
}

// The month, or week for week-based frequencies, at `position` inside a period.
function partOfPeriod(
  { frequency }: RecurrenceRule,
  period: VariablePeriod,
  position: number,
): VariablePeriod {
  if (isWeekBased(frequency)) {
    const from = addDays(period.from, 7 * position);
    return { from, to: addDays(from, 6) };
  }
  return monthPeriod(firstOfMonth(absoluteMonth(period.from) + position));
}

// The shortest period is a week and no Czech week is free of working days, so the scans stop inside it.
function scanForWorkingDay(start: CalendarDate, step: 1 | -1): CalendarDate {
  let date = start;
  while (!isWorkingDay(date)) date = addDays(date, step);
  return date;
}

function dateInPart(rule: RecurrenceRule, part: VariablePeriod): CalendarDate {
  if (rule.issueRule === "first_working_day") return scanForWorkingDay(part.from, 1);
  if (isWeekBased(rule.frequency)) return addDays(part.from, rule.issueDay! - 1);
  const day = Math.min(rule.issueDay!, Number(part.to.slice(8)));
  return `${part.from.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

// Anchors the issue month to the start: the first part of period 0 whose date is not before
// `startsOn`, repeated in every period. Without one, the plan begins in the next period's first part.
// period_end and last_working_day count from the period end, so they have no position to anchor.
function anchorPosition(rule: RecurrenceRule): number {
  if (rule.issueRule === "period_end" || rule.issueRule === "last_working_day") return 0;
  const period = periodAt(rule, 0);
  for (let position = 0; ; position++) {
    const part = partOfPeriod(rule, period, position);
    if (part.from > period.to) return 0;
    if (dateInPart(rule, part) >= rule.startsOn) return position;
  }
}

function issueDateIn(rule: RecurrenceRule, period: VariablePeriod, position: number): CalendarDate {
  if (rule.issueRule === "period_end") return period.to;
  if (rule.issueRule === "last_working_day") return scanForWorkingDay(period.to, -1);
  return dateInPart(rule, partOfPeriod(rule, period, position));
}

function firstIssueDate(rule: RecurrenceRule): CalendarDate {
  const position = anchorPosition(rule);
  const date = issueDateIn(rule, periodAt(rule, 0), position);
  return date >= rule.startsOn ? date : issueDateIn(rule, periodAt(rule, 1), position);
}

function* occurrences(rule: RecurrenceRule): Generator<Occurrence> {
  const invalid = validateRule(rule);
  if (invalid.length > 0) throw new Error(`Invalid recurrence rule: ${invalid.join(", ")}`);
  const position = anchorPosition(rule);
  let index = 0;
  for (let n = 0; rule.maxCount === null || index < rule.maxCount; n++) {
    const schedulePeriod = periodAt(rule, n);
    const issueDate = issueDateIn(rule, schedulePeriod, position);
    if (issueDate < rule.startsOn) continue;
    if (rule.endsOn !== null && issueDate > rule.endsOn) return;
    yield {
      index,
      periodKey: schedulePeriod.from,
      issueDate,
      schedulePeriod,
      billedPeriod: periodAt(rule, n + rule.periodOffset),
    };
    index++;
  }
}

export function occurrencesBetween(
  rule: RecurrenceRule,
  after: CalendarDate | null,
  through: CalendarDate,
): Occurrence[] {
  const found: Occurrence[] = [];
  for (const occurrence of occurrences(rule)) {
    if (occurrence.issueDate > through) break;
    if (after === null || occurrence.issueDate > after) found.push(occurrence);
  }
  return found;
}

export function nextOccurrences(
  rule: RecurrenceRule,
  after: CalendarDate | null,
  count: number,
): Occurrence[] {
  const found: Occurrence[] = [];
  for (const occurrence of occurrences(rule)) {
    if (found.length >= count) break;
    if (after === null || occurrence.issueDate > after) found.push(occurrence);
  }
  return found;
}
