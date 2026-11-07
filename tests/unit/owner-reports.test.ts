import { describe, expect, test } from "vitest";
import { CATCH_UP_DAYS, finishedPeriod, PERIOD_SUMMARIES, periodOfKey } from "@/lib/owner-reports";

describe("období souhrnu", () => {
  test("[REM-010] finishedPeriod: 1. 12. 2026 měsíčně dá 2026-11, 1. 1. 2027 čtvrtletně dá 2026-Q4", () => {
    expect(PERIOD_SUMMARIES).toEqual(["off", "monthly", "quarterly"]);
    expect(finishedPeriod("2026-12-01", "monthly")).toEqual({
      key: "2026-11",
      range: { from: "2026-11-01", to: "2026-11-30" },
      next: { from: "2026-12-01", to: "2026-12-31" },
      dayOfPeriod: 1,
    });
    expect(finishedPeriod("2027-01-01", "quarterly")).toEqual({
      key: "2026-Q4",
      range: { from: "2026-10-01", to: "2026-12-31" },
      next: { from: "2027-01-01", to: "2027-03-31" },
      dayOfPeriod: 1,
    });
  });

  test("[REM-010] den období roste od prvního dne a přes přestupný únor", () => {
    expect(CATCH_UP_DAYS).toBe(3);
    expect(finishedPeriod("2026-12-03", "monthly").dayOfPeriod).toBe(3);
    expect(finishedPeriod("2026-11-15", "quarterly")).toMatchObject({
      key: "2026-Q3",
      dayOfPeriod: 46,
    });
    expect(finishedPeriod("2028-03-01", "monthly")).toMatchObject({
      key: "2028-02",
      range: { from: "2028-02-01", to: "2028-02-29" },
    });
    expect(finishedPeriod("2026-01-02", "monthly")).toMatchObject({
      key: "2025-12",
      range: { from: "2025-12-01", to: "2025-12-31" },
      next: { from: "2026-01-01", to: "2026-01-31" },
      dayOfPeriod: 2,
    });
    expect(finishedPeriod("2026-04-01", "quarterly").key).toBe("2026-Q1");
  });

  test("[REM-010] klíč období se přečte zpět a cizí tvar odmítne", () => {
    expect(periodOfKey("2026-11")).toEqual({
      mode: "monthly",
      range: { from: "2026-11-01", to: "2026-11-30" },
      next: { from: "2026-12-01", to: "2026-12-31" },
    });
    expect(periodOfKey("2026-Q4")).toEqual({
      mode: "quarterly",
      range: { from: "2026-10-01", to: "2026-12-31" },
      next: { from: "2027-01-01", to: "2027-03-31" },
    });
    for (const bad of ["2026-13", "2026-Q5", "2026-00", "26-11", "2026-11-01", ""]) {
      expect(periodOfKey(bad)).toBeNull();
    }
  });
});
