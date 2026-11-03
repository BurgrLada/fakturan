import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Chart } from "@/components/charts/chart";
import type { ChartSpec } from "@/components/charts/chart-spec";
import { WidgetView } from "@/components/dashboard/widget-view";
import type { QueryWidgetConfig } from "@/lib/widget-config";

const render = (spec: ChartSpec) => renderToStaticMarkup(createElement(Chart, { spec }));

const fills = (html: string, mark: string) =>
  [...html.matchAll(new RegExp(`data-ts-key="${mark}[^"]*" fill="([^"]+)"`, "g"))].map(
    (match) => match[1],
  );

const keys = (html: string, mark: string) =>
  [...html.matchAll(new RegExp(`data-ts-key="(${mark}[^"]*)"`, "g"))].map((match) => match[1]);

const twins: Pick<ChartSpec, "series" | "format" | "ariaLabel"> = {
  series: [
    { key: "item:1", label: "Konzultace", token: "chart-1" },
    { key: "name:Konzultace", label: "Konzultace", token: "chart-2" },
  ],
  format: { kind: "money", currency: "CZK" },
  ariaLabel: "Položky",
};

describe("obal Chart", () => {
  test("[UI-005] dvě série se stejným popiskem mají vlastní barvu i klíč", () => {
    const html = render({
      ...twins,
      kind: "bar",
      rows: [{ x: "2026-01", label: "leden", values: { "item:1": 100, "name:Konzultace": 200 } }],
    });

    expect(fills(html, "bar-y-0:").sort()).toEqual(["var(--chart-1)", "var(--chart-2)"]);
    const bars = keys(html, "bar-y-0:");
    expect(new Set(bars).size).toBe(2);
    expect(fills(html, "legend-dot:").sort()).toEqual(["var(--chart-1)", "var(--chart-2)"]);
    expect(html.match(/>Konzultace<\/text>/g)).toHaveLength(2);
  });

  test("[UI-005] výseče se stejným popiskem se v koláči neslijí", () => {
    const html = render({
      ...twins,
      kind: "donut",
      rows: [{ x: "total", label: "Celkem", values: { "item:1": 100, "name:Konzultace": 200 } }],
    });

    expect(html).toContain("var(--chart-1)");
    expect(html).toContain("var(--chart-2)");
  });

  test("[UI-005] záporná hodnota v heatmapě má intenzitu nuly", () => {
    const html = render({
      kind: "heatmap",
      series: [{ key: "current", label: "Uhrazeno", token: "chart-1" }],
      rows: [
        { x: "2026-01", label: "leden", values: { current: 0 } },
        { x: "2026-02", label: "únor", values: { current: -500 } },
        { x: "2026-03", label: "březen", values: { current: 500 } },
      ],
      format: { kind: "money", currency: "CZK" },
      ariaLabel: "Úhrady",
    });

    const [zero, negative, positive] = fills(html, "rect-0:");
    expect(negative).toBe(zero);
    expect(positive).not.toBe(zero);
  });
});

describe("tabulka hodnot widgetu", () => {
  const rows = (groupBy: "customer" | "item"): string =>
    renderToStaticMarkup(
      createElement(WidgetView, {
        config: {
          v: 1,
          kind: "query",
          title: "Top",
          color: "chart-1",
          format: "auto",
          source: groupBy === "item" ? "lines" : "invoices",
          metric: "sum",
          groupBy,
          period: "this_year",
          display: "bar",
        } as QueryWidgetConfig,
        result: {
          kind: "rows",
          series: [],
          rows: [{ kind: "row", key: "c1", name: "Alfa", value: 100 }],
          total: 100,
          range: { from: "2026-01-01", to: "2026-12-31" },
          unconverted: { count: 0, byCurrency: [] },
        },
        unit: { kind: "money", currency: "CZK" },
        title: "Top",
        h: 4,
        dateFormat: "d. M. yyyy",
      }),
    );

  test("[UI-008] roh tabulky po zákaznících a položkách nese jejich název, ne období", () => {
    const corner = (html: string) => /<thead><tr[^>]*><th[^>]*>([^<]*)<\/th>/.exec(html)?.[1];

    expect(corner(rows("customer"))).toBe("Zákazník");
    expect(corner(rows("item"))).toBe("Položka");
  });
});
