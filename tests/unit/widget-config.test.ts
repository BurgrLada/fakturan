import { describe, expect, test } from "vitest";
import { DEFAULT_DASHBOARD, WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import {
  parseWidgetConfig,
  SOURCE_FIELDS,
  WIDGET_CONFIG_VERSION,
  widgetConfigSchema,
  WidgetConfigError,
  type QueryWidgetConfig,
} from "@/lib/widget-config";

const base: QueryWidgetConfig = {
  v: 1,
  kind: "query",
  title: "Fakturováno",
  color: "chart-1",
  format: "auto",
  source: "invoices",
  metric: "sum",
  measure: "invoiced",
  period: "this_year",
  display: "number",
};

function rejection(raw: unknown): WidgetConfigError {
  try {
    parseWidgetConfig(raw);
  } catch (error) {
    if (error instanceof WidgetConfigError) return error;
    throw error;
  }
  throw new Error("Konfigurace prošla");
}

function keysOf(schema: unknown, seen = new Set<unknown>()): string[] {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def ?? {};
  const shape = (def.shape ?? {}) as Record<string, unknown>;
  const nested = [
    ...Object.values(shape),
    ...((def.options as unknown[]) ?? []),
    def.innerType,
    def.element,
    def.in,
    def.out,
    def.left,
    def.right,
    def.schema,
  ];
  return [...Object.keys(shape), ...nested.flatMap((child) => keysOf(child, seen))];
}

describe("schéma konfigurace widgetu", () => {
  test("[DSH-018] neznámý klíč, kind nebo verze je odmítnutá s cestou v JSON", () => {
    expect(parseWidgetConfig(base)).toEqual(base);
    expect(WIDGET_CONFIG_VERSION).toBe(1);

    expect(rejection({ ...base, extra: 1 }).path).toBe("extra");
    expect(rejection({ ...base, filters: { sql: "1" } }).path).toBe("filters.sql");
    expect(rejection({ ...base, filters: { sql: "1" } }).message).toBe("filters.sql: Neznámý klíč");
    expect(
      rejection({ ...base, period: { from: "2026-01-01", to: "2026-02-01", x: 1 } }).path,
    ).toBe("period.x");
    expect(rejection({ ...base, v: 2 }).path).toBe("v");
    expect(rejection({ ...base, kind: "script" }).path).toBe("kind");
    expect(rejection({ ...base, measure: undefined, source: "customers" }).path).toBe("metric");
    expect(
      rejection({ ...base, measure: undefined, source: "payments", filters: { status: ["paid"] } })
        .path,
    ).toBe("filters.status");
    expect(rejection({ ...base, filters: { status: ["draft"] } }).path).toBe("filters.status.0");
    expect(rejection({ ...base, filters: { status: ["cancelled"] } }).path).toBe(
      "filters.status.0",
    );
    expect(rejection(null).path).toBe("");
  });

  test('[DSH-018] groupBy "1; DROP TABLE invoice" neprojde schématem', () => {
    const error = rejection({ ...base, display: "table", groupBy: "1; DROP TABLE invoice" });
    expect(error.path).toBe("groupBy");
    for (const field of ["source", "metric", "measure", "splitBy", "display", "color", "format"]) {
      expect(rejection({ ...base, [field]: "invoice.total_minor" }).path).toBe(field);
    }
    expect(rejection({ ...base, period: "date('now')" }).path).toBe("period");
    expect(rejection({ ...base, period: { from: "2026-01-01'", to: "2026-02-01" } }).path).toBe(
      "period.from",
    );
    expect(
      rejection({ ...base, topN: "5 OR 1=1", display: "table", groupBy: "customer" }).path,
    ).toBe("topN");
  });

  test("[DSH-018] schéma nezná pole pro kód, SQL ani vlastní výraz", () => {
    const keys = new Set(keysOf(widgetConfigSchema));
    expect(keys.size).toBeGreaterThan(10);
    for (const key of keys) {
      expect(key).not.toMatch(/code|sql|script|expr|formula|query|column|raw|function|orderBy/i);
    }
    for (const field of ["code", "sql", "expression", "orderBy", "column"]) {
      expect(rejection({ ...base, [field]: "x" }).path).toBe(field);
    }
  });

  test("povolené kombinace řídí tabulka SOURCE_FIELDS", () => {
    expect(SOURCE_FIELDS.customers.metrics).toEqual(["count"]);
    expect(SOURCE_FIELDS.lines.groupBy).toContain("item");
    expect(SOURCE_FIELDS.invoices.groupBy).not.toContain("item");
    expect(rejection({ ...base, display: "table", groupBy: "item" }).path).toBe("groupBy");
    expect(rejection({ ...base, source: "lines", metric: "days_to_pay" }).path).toBe("metric");
    expect(rejection({ ...base, source: "lines", measure: "overdue" }).path).toBe("measure");
    expect(
      rejection({ ...base, metric: "days_to_pay", display: "table", groupBy: "month" }).path,
    ).toBe("groupBy");
    expect(
      rejection({ ...base, metric: "median", display: "table", groupBy: "customer", topN: 3 }).path,
    ).toBe("topN");
    expect(rejection({ ...base, display: "heatmap", groupBy: "month" }).path).toBe("groupBy");
    expect(rejection({ ...base, display: "bar", groupBy: "month", cumulative: true }).path).toBe(
      "cumulative",
    );
    expect(rejection({ ...base, display: "stacked_bar", groupBy: "month" }).path).toBe("splitBy");
    expect(rejection({ ...base, measure: "overdue", display: "bar", groupBy: "month" }).path).toBe(
      "groupBy",
    );
    expect(rejection({ ...base, measure: "outstanding", compare: "previous" }).path).toBe(
      "compare",
    );
    expect(rejection({ ...base, display: "number_compare" }).path).toBe("compare");
    expect(
      parseWidgetConfig({ ...base, display: "stacked_bar", groupBy: "month", splitBy: "currency" }),
    ).toMatchObject({ splitBy: "currency" });
    expect(
      parseWidgetConfig({ ...base, display: "heatmap", groupBy: "day", period: "last_12_months" }),
    ).toBeTruthy();
  });

  test("absolutní období nad 10 let a denní koše nad 400 schéma odmítne", () => {
    const tenYears = { from: "2016-11-03", to: "2026-11-02" };
    expect(parseWidgetConfig({ ...base, period: tenYears })).toBeTruthy();
    expect(rejection({ ...base, period: { from: "2016-11-02", to: "2026-11-02" } }).path).toBe(
      "period",
    );
    expect(rejection({ ...base, period: { from: "2026-12-01", to: "2026-01-01" } }).path).toBe(
      "period",
    );
    const days = { from: "2025-01-01", to: "2026-02-05" };
    expect(rejection({ ...base, display: "bar", groupBy: "day", period: days }).path).toBe(
      "groupBy",
    );
    const fits = { ...base, display: "bar", groupBy: "day", period: { ...days, to: "2026-02-04" } };
    expect(parseWidgetConfig(fits)).toEqual(fits);
  });

  test("galerie má 22 platných widgetů a výchozí dashboard kartu splatností", () => {
    expect(WIDGET_GALLERY).toHaveLength(22);
    expect(WIDGET_GALLERY.filter((item) => item.config.kind === "query")).toHaveLength(13);
    expect(new Set(WIDGET_GALLERY.map((item) => item.id)).size).toBe(22);
    for (const item of WIDGET_GALLERY) expect(parseWidgetConfig(item.config)).toEqual(item.config);
    expect(
      DEFAULT_DASHBOARD.widgets.filter(
        (w) => w.config.kind === "system" && w.config.systemId === "due_alerts",
      ),
    ).toHaveLength(1);
  });
});
