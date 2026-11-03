import { describe, expect, test } from "vitest";
import { WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import { widgetConfigSchema, type QueryWidgetConfig } from "@/lib/widget-config";
import { labelsAllowed, QUERY_FIELDS, queryOptions, setQueryField } from "@/lib/widget-options";

const queries = WIDGET_GALLERY.flatMap((item) =>
  item.config.kind === "query" ? [item.config] : [],
);
const gallery = (id: string) =>
  WIDGET_GALLERY.find((item) => item.id === id)!.config as QueryWidgetConfig;

describe("volby konfigurátoru", () => {
  test("každá nabídnutá volba vede k platné konfiguraci", () => {
    for (const config of queries) {
      for (const field of QUERY_FIELDS) {
        const options = queryOptions(config, field);
        expect(options.length, `${config.title} ${field}`).toBeGreaterThan(0);
        for (const value of options) {
          const next = setQueryField(config, field, value);
          const parsed = widgetConfigSchema.safeParse(next);
          expect(parsed.success, `${config.title} ${field}=${String(value)}`).toBe(true);
          expect(next.labels === undefined || labelsAllowed(next)).toBe(true);
        }
      }
    }
  });

  test("změna zdroje zahodí volby, které nový zdroj nemá", () => {
    const start: QueryWidgetConfig = {
      ...gallery("top_customers"),
      filters: { currency: "EUR", status: ["paid"] },
    };
    const customers = setQueryField(start, "source", "customers");
    expect(customers).toMatchObject({ source: "customers", metric: "count" });
    expect(customers.measure).toBeUndefined();
    expect(customers.filters).toBeUndefined();
    expect(customers.topN).toBeUndefined();
    expect(queryOptions(customers, "metric")).toEqual(["count"]);
    expect(queryOptions(customers, "groupBy")).not.toContain("customer");
    expect(queryOptions(customers, "filter:currency")).toEqual([undefined]);

    const payments = setQueryField(start, "source", "payments");
    expect(payments.filters).toEqual({ currency: "EUR" });
    expect(queryOptions(payments, "metric")).not.toContain("days_to_pay");
  });

  test("stav k dnešku nemá období ani průběh v čase", () => {
    const outstanding = gallery("outstanding");
    expect(queryOptions(outstanding, "period")).toEqual([undefined]);
    expect(queryOptions(outstanding, "compare")).toEqual([undefined]);
    expect(queryOptions(outstanding, "groupBy")).not.toContain("month");
    const invoiced = setQueryField(outstanding, "measure", "invoiced");
    expect(invoiced.period).toBe("this_year");
    expect(queryOptions(invoiced, "period")).not.toContain(undefined);
    expect(setQueryField(invoiced, "measure", "overdue").period).toBeUndefined();
  });

  test("graf si doplní seskupení a popisky jen tam, kde dávají smysl", () => {
    const number = { ...gallery("invoiced_this_year"), labels: true };
    const bar = setQueryField(number, "display", "bar");
    expect(bar).toMatchObject({ display: "bar", groupBy: "month" });
    expect(setQueryField({ ...bar, labels: true }, "display", "table").labels).toBeUndefined();
    expect(labelsAllowed(setQueryField(bar, "compare", "year"))).toBe(false);
  });
});
