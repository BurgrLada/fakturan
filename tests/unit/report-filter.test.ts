import { describe, expect, test } from "vitest";
import {
  bucketLabel,
  bucketUnitFor,
  filterFromQuery,
  parseReportFilter,
  reportParams,
  reportPeriodToken,
  reportQuery,
  type ParsedReportFilter,
} from "@/lib/report-filter";

const TODAY = "2026-11-02";
const YEAR = { from: "2026-01-01", to: "2026-12-31" };

describe("filtr statistik", () => {
  test("bez parametrů je letošní rok v CZK s importovanými a porovnáním s předchozím obdobím", () => {
    expect(parseReportFilter({}, TODAY)).toEqual({
      tab: "fakturace",
      range: YEAR,
      compare: "previous",
      includeExternal: true,
    });
  });

  test("neplatné parametry filtru nespadnou a použijí výchozí", () => {
    expect(
      parseReportFilter(
        {
          zalozka: "tajne",
          obdobi: "vcera",
          od: "2026-13-01",
          do: "x",
          porovnani: "nikdy",
          mena: "BTC",
          importovane: ["ne", "ano"],
        },
        TODAY,
      ),
    ).toEqual({ tab: "fakturace", range: YEAR, compare: "previous", includeExternal: false });
    expect(
      parseReportFilter({ obdobi: "vlastni", od: "2026-05-01", do: "2026-04-01" }, TODAY),
    ).toMatchObject({ range: YEAR });
    expect(parseReportFilter({ od: "2010-01-01", do: "2026-01-01" }, TODAY)).toMatchObject({
      range: YEAR,
    });
  });

  test("platné hodnoty projdou a token má přednost před daty", () => {
    expect(
      parseReportFilter(
        {
          zalozka: "predpoved",
          obdobi: "minuly-rok",
          porovnani: "rok",
          mena: "EUR",
          od: "2026-02-01",
          do: "2026-02-10",
        },
        TODAY,
      ),
    ).toEqual({
      tab: "predpoved",
      range: { from: "2025-01-01", to: "2025-12-31" },
      compare: "year",
      currency: "EUR",
      includeExternal: true,
    });
    expect(parseReportFilter({ od: "2026-02-01", do: "2026-02-10" }, TODAY)).toMatchObject({
      range: { from: "2026-02-01", to: "2026-02-10" },
    });
    expect(
      parseReportFilter({ obdobi: "vlastni", od: "2017-01-01", do: "2026-12-31" }, TODAY),
    ).toMatchObject({ range: { from: "2017-01-01", to: "2026-12-31" } });
  });

  test("parametry a dotaz pro cache jsou kanonické a vrátí stejný filtr", () => {
    const filter = parseReportFilter({ obdobi: "mesic", mena: "EUR", importovane: "ne" }, TODAY);
    expect(reportParams(filter, TODAY)).toEqual({
      zalozka: "fakturace",
      obdobi: "mesic",
      porovnani: "predchozi",
      mena: "EUR",
      importovane: "ne",
    });
    const custom = parseReportFilter({ od: "2026-02-01", do: "2026-02-10" }, TODAY);
    expect(reportParams(custom, TODAY)).toMatchObject({
      obdobi: "vlastni",
      od: "2026-02-01",
      do: "2026-02-10",
    });
    expect(reportPeriodToken(custom.range, TODAY)).toBeNull();

    const query = reportQuery(filter);
    const otherTab: ParsedReportFilter = { ...filter, tab: "limity" };
    expect(query).toBe(reportQuery(otherTab));
    expect(filterFromQuery(query)).toEqual({
      range: filter.range,
      currency: "EUR",
      includeExternal: false,
      compare: "previous",
    });
    expect(() => filterFromQuery('{"range":1}')).toThrow();
  });

  test("délka období volí časový koš do 400 košů", () => {
    expect(bucketUnitFor({ from: "2026-11-01", to: "2026-11-30" })).toBe("day");
    expect(bucketUnitFor(YEAR)).toBe("month");
    expect(bucketUnitFor({ from: "2017-01-01", to: "2026-12-31" })).toBe("quarter");
  });
});

describe("popisky košů", () => {
  test("koše mají české popisky", () => {
    expect(bucketLabel("2026-03-10", "day")).toBe("10. 3. 2026");
    expect(bucketLabel("2026-03", "month")).toBe("březen 2026");
    expect(bucketLabel("2026-Q1", "quarter")).toBe("1. čtvrtletí 2026");
    expect(bucketLabel("2026-W05", "week")).toBe("5. týden 2026");
    expect(bucketLabel("2026", "year")).toBe("2026");
  });
});
