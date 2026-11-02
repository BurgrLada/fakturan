import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { bucketKey, bucketsBetween, previousRange, resolvePeriod } from "@/lib/report-period";

const DAY = 86_400_000;
const START = Date.UTC(2000, 0, 1);

const date = fc
  .integer({ min: 0, max: 365 * 40 })
  .map((offset) => new Date(START + offset * DAY).toISOString().slice(0, 10));

const range = fc.tuple(date, fc.integer({ min: 0, max: 800 })).map(([from, length]) => ({
  from,
  to: new Date(Date.parse(from) + length * DAY).toISOString().slice(0, 10),
}));

const monthRange = fc
  .tuple(fc.integer({ min: 2000, max: 2040 }), fc.integer({ min: 0, max: 11 }), fc.nat(30))
  .map(([year, month, length]) => ({
    from: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, month + length + 1, 0)).toISOString().slice(0, 10),
  }));

const dayBefore = (value: string) => new Date(Date.parse(value) - DAY).toISOString().slice(0, 10);

describe("předchozí období", () => {
  test("předchozí období nikdy nepřekrývá období a končí den před ním", () => {
    fc.assert(
      fc.property(fc.oneof(range, monthRange), (current) => {
        const previous = previousRange(current, "previous");
        expect(previous.to).toBe(dayBefore(current.from));
        expect(previous.from <= previous.to).toBe(true);
        expect(resolvePeriod(previous, current.to)).toEqual(previous);
      }),
    );
  });

  test("celé měsíce mají předchozí stejný počet celých měsíců, jinak stejný počet dní", () => {
    fc.assert(
      fc.property(monthRange, (current) => {
        const previous = previousRange(current, "previous");
        expect(previous.from.endsWith("-01")).toBe(true);
        expect(bucketsBetween(previous, "month")).toHaveLength(
          bucketsBetween(current, "month").length,
        );
      }),
    );
    fc.assert(
      fc.property(range, (current) => {
        const previous = previousRange(current, "previous");
        expect(bucketsBetween(previous, "day")).toHaveLength(bucketsBetween(current, "day").length);
      }),
    );
  });

  test("koše pokryjí každý den období právě jednou a v pořadí", () => {
    fc.assert(
      fc.property(range, fc.constantFrom("week", "month", "quarter", "year"), (current, unit) => {
        const keys = bucketsBetween(current, unit as "week");
        const days = bucketsBetween(current, "day");
        const seen = [...new Set(days.map((day) => bucketKey(day, unit as "week")))];
        expect(keys).toEqual(seen);
      }),
    );
  });
});
