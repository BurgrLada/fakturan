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

// Returns the names of invalid fields. The bounds also guarantee that every computation below ends.
export function validateRule(rule: RecurrenceRule): string[] {
  const { frequency, every, issueRule, startsOn, endsOn, maxCount, periodOffset } = rule;
  const validFrequency = RECURRENCE_FREQUENCIES.includes(frequency);
  const validStart = isCalendarDate(startsOn);
  const invalid: [string, boolean][] = [
    ["frequency", !validFrequency],
    ["every", validFrequency && !isIntegerBetween(every, 1, MAX_EVERY[frequency])],
    ["issueRule", !ISSUE_RULES.includes(issueRule)],
    ["issueDay", ISSUE_RULES.includes(issueRule) && !isValidIssueDay(rule)],
    ["startsOn", !validStart],
    ["endsOn", endsOn !== null && (!isCalendarDate(endsOn) || (validStart && endsOn < startsOn))],
    ["maxCount", maxCount !== null && !isIntegerBetween(maxCount, 1, Number.MAX_SAFE_INTEGER)],
    ["periodOffset", !isIntegerBetween(periodOffset, -MAX_PERIOD_OFFSET, MAX_PERIOD_OFFSET)],
  ];
  return invalid.filter(([, isInvalid]) => isInvalid).map(([field]) => field);
}

function firstOfMonth(absoluteMonth: number): CalendarDate {
  const year = String(Math.floor(absoluteMonth / 12)).padStart(4, "0");
  const month = String((absoluteMonth % 12) + 1).padStart(2, "0");
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
  const startMonth = Number(startsOn.slice(0, 4)) * 12 + Number(startsOn.slice(5, 7)) - 1;
  const first = Math.floor(startMonth / unit) * unit + n * months;
  return { from: firstOfMonth(first), to: monthPeriod(firstOfMonth(first + months - 1)).to };
}

function dayInPeriod({ frequency }: RecurrenceRule, issueDay: number, period: VariablePeriod) {
  if (isWeekBased(frequency)) return addDays(period.from, issueDay - 1);
  const monthEnd = monthPeriod(period.from).to;
  const day = Math.min(issueDay, Number(monthEnd.slice(8)));
  return `${period.from.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

// The shortest period is a week and no Czech week is free of working days, so the scans stop inside it.
function scanForWorkingDay(start: CalendarDate, step: 1 | -1): CalendarDate {
  let date = start;
  while (!isWorkingDay(date)) date = addDays(date, step);
  return date;
}

function issueDateIn(rule: RecurrenceRule, period: VariablePeriod): CalendarDate {
  if (rule.issueRule === "day") return dayInPeriod(rule, rule.issueDay!, period);
  if (rule.issueRule === "period_end") return period.to;
  if (rule.issueRule === "first_working_day") return scanForWorkingDay(period.from, 1);
  return scanForWorkingDay(period.to, -1);
}

function* occurrences(rule: RecurrenceRule): Generator<Occurrence> {
  const invalid = validateRule(rule);
  if (invalid.length > 0) throw new Error(`Invalid recurrence rule: ${invalid.join(", ")}`);
  let index = 0;
  for (let n = 0; rule.maxCount === null || index < rule.maxCount; n++) {
    const schedulePeriod = periodAt(rule, n);
    const issueDate = issueDateIn(rule, schedulePeriod);
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
