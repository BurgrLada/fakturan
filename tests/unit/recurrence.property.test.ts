import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays } from "@/lib/invoice";
import {
  ISSUE_RULES,
  nextOccurrences,
  occurrencesBetween,
  RECURRENCE_FREQUENCIES,
  validateRule,
  type RecurrenceRule,
} from "@/lib/recurrence";

const calendarDate = fc
  .date({ min: new Date("2020-01-01"), max: new Date("2040-12-31"), noInvalidDate: true })
  .map((date) => date.toISOString().slice(0, 10));

const isWeekBased = (frequency: RecurrenceRule["frequency"]) =>
  frequency === "weekly" || frequency === "every_weeks";

const arbitraryRule: fc.Arbitrary<RecurrenceRule> = fc
  .record({
    frequency: fc.constantFrom(...RECURRENCE_FREQUENCIES),
    weeks: fc.integer({ min: 1, max: 52 }),
    months: fc.integer({ min: 1, max: 24 }),
    issueRule: fc.constantFrom(...ISSUE_RULES),
    day: fc.integer({ min: 1, max: 31 }),
    weekday: fc.integer({ min: 1, max: 7 }),
    startsOn: calendarDate,
    span: fc.option(fc.integer({ min: 0, max: 2000 })),
    maxCount: fc.option(fc.integer({ min: 1, max: 60 })),
    periodOffset: fc.integer({ min: -12, max: 12 }),
  })
  .map(({ frequency, weeks, months, issueRule, day, weekday, startsOn, span, ...rest }) => ({
    frequency,
    every: frequency === "every_weeks" ? weeks : frequency === "every_months" ? months : 1,
    issueRule,
    issueDay: issueRule !== "day" ? null : isWeekBased(frequency) ? weekday : day,
    startsOn,
    endsOn: span === null ? null : addDays(startsOn, span),
    ...rest,
  }));

const horizon = fc.integer({ min: 0, max: 1500 });

describe("vlastnosti plánů", () => {
  test("[TST-012] termíny rostou, periodKey je unikátní a datum leží v období", () => {
    fc.assert(
      fc.property(arbitraryRule, horizon, (rule, days) => {
        expect(validateRule(rule)).toEqual([]);
        const list = occurrencesBetween(rule, null, addDays(rule.startsOn, days));
        expect(new Set(list.map((o) => o.periodKey)).size).toBe(list.length);
        list.forEach((occurrence, position) => {
          expect(occurrence.index).toBe(position);
          expect(occurrence.periodKey).toBe(occurrence.schedulePeriod.from);
          expect(occurrence.issueDate >= occurrence.schedulePeriod.from).toBe(true);
          expect(occurrence.issueDate <= occurrence.schedulePeriod.to).toBe(true);
          expect(occurrence.issueDate >= rule.startsOn).toBe(true);
          if (rule.endsOn) expect(occurrence.issueDate <= rule.endsOn).toBe(true);
          if (rule.maxCount) expect(position).toBeLessThan(rule.maxCount);
          const next = list[position + 1];
          if (next) expect(occurrence.issueDate < next.issueDate).toBe(true);
        });
      }),
      { numRuns: 300 },
    );
  });

  test("[TST-012] období na sebe navazují a týdny začínají v pondělí", () => {
    fc.assert(
      fc.property(arbitraryRule, (rule) => {
        const list = nextOccurrences({ ...rule, endsOn: null, maxCount: null }, null, 8);
        expect(list).toHaveLength(8);
        for (const [position, occurrence] of list.entries()) {
          const { from, to } = occurrence.schedulePeriod;
          if (isWeekBased(rule.frequency)) {
            expect(new Date(Date.parse(from)).getUTCDay()).toBe(1);
          } else {
            expect(from.slice(8)).toBe("01");
          }
          const next = list[position + 1];
          if (next) expect(addDays(to, 1)).toBe(next.schedulePeriod.from);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("[TST-012] fakturované období je plánovací období o posun dál", () => {
    fc.assert(
      fc.property(arbitraryRule, (rule) => {
        const list = nextOccurrences({ ...rule, endsOn: null, maxCount: null }, null, 30);
        list.forEach((occurrence, position) => {
          const shifted = list[position + rule.periodOffset];
          if (shifted) expect(occurrence.billedPeriod).toEqual(shifted.schedulePeriod);
        });
      }),
      { numRuns: 300 },
    );
  });

  test("[TST-012] pokračování od after dá stejnou posloupnost jako celý výpočet", () => {
    fc.assert(
      fc.property(arbitraryRule, horizon, horizon, (rule, a, b) => {
        const after = addDays(rule.startsOn, Math.min(a, b));
        const through = addDays(rule.startsOn, Math.max(a, b));
        const whole = occurrencesBetween(rule, null, through);
        const continued = [
          ...occurrencesBetween(rule, null, after),
          ...occurrencesBetween(rule, after, through),
        ];
        expect(continued).toEqual(whole);
        const rest = whole.filter((occurrence) => occurrence.issueDate > after);
        expect(nextOccurrences(rule, after, rest.length)).toEqual(rest);
      }),
      { numRuns: 300 },
    );
  });
});
