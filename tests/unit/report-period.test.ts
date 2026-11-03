import { describe, expect, test } from "vitest";
import {
  bucketKey,
  bucketsBetween,
  comparisonRange,
  previousRange,
  resolvePeriod,
} from "@/lib/report-period";

const TODAY = "2026-11-02";

describe("období", () => {
  test("tokeny k 2. 11. 2026", () => {
    expect(resolvePeriod("this_month", TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(resolvePeriod("this_quarter", TODAY)).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
    expect(resolvePeriod("this_quarter", "2026-03-31")).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(resolvePeriod("this_year", TODAY)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(resolvePeriod("last_year", TODAY)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolvePeriod("last_30_days", TODAY)).toEqual({
      from: "2026-10-04",
      to: "2026-11-02",
    });
    expect(resolvePeriod("this_month", "2028-02-10")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  test("posledních 12 měsíců k 2. 11. 2026 je 3. 11. 2025 až 2. 11. 2026", () => {
    expect(resolvePeriod("last_12_months", TODAY)).toEqual({
      from: "2025-11-03",
      to: "2026-11-02",
    });
  });

  test("absolutní období zůstane a obrácené nebo vadné se odmítne", () => {
    const range = { from: "2026-03-10", to: "2026-03-19" };
    expect(resolvePeriod(range, TODAY)).toEqual(range);
    expect(resolvePeriod({ from: "2026-03-10", to: "2026-03-10" }, TODAY)).toEqual({
      from: "2026-03-10",
      to: "2026-03-10",
    });
    expect(() => resolvePeriod({ from: "2026-03-20", to: "2026-03-19" }, TODAY)).toThrow(
      RangeError,
    );
    expect(() => resolvePeriod({ from: "2026-02-30", to: "2026-03-19" }, TODAY)).toThrow(
      RangeError,
    );
    expect(() => resolvePeriod({ from: "2026-02-01", to: "2026-13-01" }, TODAY)).toThrow(
      RangeError,
    );
    expect(() => resolvePeriod("next_year" as never, TODAY)).toThrow(RangeError);
  });

  test("březen 2026 má předchozí únor 2026 a loňský březen 2025", () => {
    const march = { from: "2026-03-01", to: "2026-03-31" };
    expect(previousRange(march, "previous")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange(march, "year")).toEqual({ from: "2025-03-01", to: "2025-03-31" });
  });

  test("Q1 2026 má předchozí Q4 2025", () => {
    expect(previousRange({ from: "2026-01-01", to: "2026-03-31" }, "previous")).toEqual({
      from: "2025-10-01",
      to: "2025-12-31",
    });
    expect(previousRange({ from: "2026-01-01", to: "2026-12-31" }, "previous")).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  test("10. až 19. 3. 2026 má předchozích 10 dní 28. 2. až 9. 3.", () => {
    expect(previousRange({ from: "2026-03-10", to: "2026-03-19" }, "previous")).toEqual({
      from: "2026-02-28",
      to: "2026-03-09",
    });
    expect(previousRange({ from: "2026-03-01", to: "2026-03-30" }, "previous")).toEqual({
      from: "2026-01-30",
      to: "2026-02-28",
    });
    expect(previousRange({ from: "2026-03-02", to: "2026-03-31" }, "previous")).toEqual({
      from: "2026-01-31",
      to: "2026-03-01",
    });
  });

  test("29. 2. 2028 o rok zpět je 28. 2. 2027", () => {
    expect(previousRange({ from: "2028-02-29", to: "2028-02-29" }, "year")).toEqual({
      from: "2027-02-28",
      to: "2027-02-28",
    });
    expect(previousRange({ from: "2028-02-01", to: "2028-02-29" }, "year")).toEqual({
      from: "2027-02-01",
      to: "2027-02-28",
    });
  });
});

describe("porovnání neukončeného období", () => {
  const compared = (token: "this_month" | "this_quarter" | "this_year", today: string) => {
    const range = resolvePeriod(token, today);
    return {
      previous: comparisonRange(range, "previous", today),
      year: comparisonRange(range, "year", today),
    };
  };

  test("[REP-001] letos k 3. 11. 2026 se porovná s 1. 1. až 3. 11. 2025", () => {
    expect(compared("this_year", "2026-11-03")).toEqual({
      previous: { from: "2025-01-01", to: "2025-11-03" },
      year: { from: "2025-01-01", to: "2025-11-03" },
    });
  });

  test("[REP-001] měsíc a čtvrtletí se porovnají do stejného dne", () => {
    expect(compared("this_month", "2026-11-03")).toEqual({
      previous: { from: "2026-10-01", to: "2026-10-03" },
      year: { from: "2025-11-01", to: "2025-11-03" },
    });
    expect(compared("this_quarter", "2026-11-03")).toEqual({
      previous: { from: "2026-07-01", to: "2026-08-03" },
      year: { from: "2025-10-01", to: "2025-11-03" },
    });
  });

  test("[REP-001] den, který kratší měsíc nemá, přejde na jeho konec", () => {
    expect(compared("this_month", "2026-03-31").previous).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(compared("this_quarter", "2026-05-31").previous).toEqual({
      from: "2026-01-01",
      to: "2026-02-28",
    });
    expect(compared("this_year", "2028-02-29").year).toEqual({
      from: "2027-01-01",
      to: "2027-02-28",
    });
  });

  test("[REP-001] ukončené období a vlastní rozsah se porovnají celé", () => {
    const today = "2026-11-03";
    for (const range of [
      resolvePeriod("last_year", today),
      resolvePeriod("last_30_days", today),
      resolvePeriod("last_12_months", today),
      { from: "2026-10-01", to: "2026-10-31" },
      { from: "2026-11-01", to: "2026-11-15" },
    ]) {
      for (const mode of ["previous", "year"] as const) {
        expect(comparisonRange(range, mode, today)).toEqual(previousRange(range, mode));
      }
    }
  });
});

describe("časové koše", () => {
  test("31. 12. 2026 i 1. 1. 2027 jsou týden 2026-W53", () => {
    expect(bucketKey("2026-12-31", "week")).toBe("2026-W53");
    expect(bucketKey("2027-01-01", "week")).toBe("2026-W53");
    expect(bucketKey("2027-01-03", "week")).toBe("2026-W53");
    expect(bucketKey("2027-01-04", "week")).toBe("2027-W01");
    expect(bucketKey("2025-12-29", "week")).toBe("2026-W01");
    expect(bucketKey("2026-03-09", "week")).toBe("2026-W11");
  });

  test("klíče dne, měsíce, čtvrtletí a roku", () => {
    expect(bucketKey("2026-05-07", "day")).toBe("2026-05-07");
    expect(bucketKey("2026-05-07", "month")).toBe("2026-05");
    expect(bucketKey("2026-01-31", "quarter")).toBe("2026-Q1");
    expect(bucketKey("2026-04-01", "quarter")).toBe("2026-Q2");
    expect(bucketKey("2026-09-30", "quarter")).toBe("2026-Q3");
    expect(bucketKey("2026-12-31", "quarter")).toBe("2026-Q4");
    expect(bucketKey("2026-12-31", "year")).toBe("2026");
  });

  test("vadné datum nebo jednotka se odmítne", () => {
    expect(() => bucketKey("2026-02-30", "day")).toThrow(RangeError);
    expect(() => bucketKey("2026-5-7", "month")).toThrow(RangeError);
    expect(() => bucketKey("2026-05-071", "day")).toThrow(RangeError);
    expect(() => bucketKey("x2026-05-07", "day")).toThrow(RangeError);
    expect(() => bucketKey("2026-04-31", "day")).toThrow(RangeError);
    expect(() => bucketKey("2026-05-07", "hour" as never)).toThrow(RangeError);
  });

  test("koše mezi daty jsou souvislé a bez mezer", () => {
    expect(bucketsBetween({ from: "2026-02-27", to: "2026-03-02" }, "day")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(bucketsBetween({ from: "2026-12-30", to: "2027-01-12" }, "week")).toEqual([
      "2026-W53",
      "2027-W01",
      "2027-W02",
    ]);
    expect(bucketsBetween({ from: "2026-01-31", to: "2026-04-01" }, "month")).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    expect(bucketsBetween({ from: "2025-11-03", to: "2026-11-02" }, "quarter")).toEqual([
      "2025-Q4",
      "2026-Q1",
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
    ]);
    expect(bucketsBetween({ from: "2025-12-31", to: "2027-01-01" }, "year")).toEqual([
      "2025",
      "2026",
      "2027",
    ]);
    expect(bucketsBetween({ from: "2026-05-05", to: "2026-05-05" }, "month")).toEqual(["2026-05"]);
  });
});
