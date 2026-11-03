import { describe, expect, test } from "vitest";
import {
  dashboardFilterParams,
  parseDashboardFilter,
  parseWidgetQuery,
  widgetQuery,
} from "@/lib/dashboard-filter";
import { WIDGET_GALLERY } from "@/lib/dashboard-defaults";

const TODAY = "2026-11-02";

describe("globální filtr dashboardu", () => {
  test("bez parametrů nic nepřebíjí", () => {
    expect(parseDashboardFilter({}, TODAY)).toEqual({});
  });

  test("[DSH-005] období, měna a porovnání se přečtou z URL", () => {
    expect(
      parseDashboardFilter({ obdobi: "minuly-rok", mena: "EUR", porovnani: "rok" }, TODAY),
    ).toEqual({ period: "last_year", currency: "EUR", compare: "year" });
    expect(
      parseDashboardFilter({ obdobi: "vlastni", od: "2026-03-01", do: "2026-03-31" }, TODAY),
    ).toEqual({ period: { from: "2026-03-01", to: "2026-03-31" } });
  });

  test("[DSH-005] parametry filtru se po neplatné hodnotě zahodí", () => {
    expect(
      parseDashboardFilter(
        { obdobi: "navzdy", mena: "XYZ", porovnani: "vcera", dashboard: "x" },
        TODAY,
      ),
    ).toEqual({});
    expect(
      parseDashboardFilter({ obdobi: "vlastni", od: "2026-04-01", do: "2026-03-01" }, TODAY),
    ).toEqual({});
    expect(
      parseDashboardFilter({ obdobi: "vlastni", od: "2026-02-30", do: "2026-03-01" }, TODAY),
    ).toEqual({});
    expect(
      parseDashboardFilter({ obdobi: "vlastni", od: "2010-01-01", do: "2026-03-01" }, TODAY),
    ).toEqual({});
    expect(parseDashboardFilter({ obdobi: ["rok", "mesic"], mena: ["CZK"] }, TODAY)).toEqual({
      period: "this_year",
      currency: "CZK",
    });
  });

  test("vlastní období shodné s relativním zůstane relativní", () => {
    expect(
      parseDashboardFilter({ obdobi: "vlastni", od: "2026-01-01", do: "2026-12-31" }, TODAY),
    ).toEqual({ period: "this_year" });
  });

  test("parametry filtru projdou tam a zpět", () => {
    for (const filter of [
      {},
      { period: "this_month" as const, currency: "USD" as const, compare: "previous" as const },
      { period: { from: "2025-02-01", to: "2025-05-15" } },
    ]) {
      expect(parseDashboardFilter(dashboardFilterParams(filter), TODAY)).toEqual(filter);
    }
  });

  test("klíč cache widgetu nese konfiguraci i filtr a jde přečíst zpět", () => {
    const config = WIDGET_GALLERY[0]!.config;
    const query = widgetQuery(config, { currency: "EUR" });
    expect(parseWidgetQuery(query)).toEqual({ config, filter: { currency: "EUR" } });
    expect(widgetQuery(config, {})).not.toBe(query);
    expect(() => parseWidgetQuery(JSON.stringify({ config, filter: { mena: "EUR" } }))).toThrow();
  });
});
