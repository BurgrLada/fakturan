import type { WidgetDraft } from "./dashboard-layout";
import { TEXTS } from "./texts";
import type { QueryWidgetConfig, SystemWidgetConfig, WidgetConfig } from "./widget-config";

const G = TEXTS.dashboard.gallery;

type Size = { w: number; h: number };
export type GalleryItem = { id: string; size: Size; config: WidgetConfig };

const NUMBER: Size = { w: 3, h: 2 };
const CHART: Size = { w: 6, h: 4 };
const LIST: Size = { w: 4, h: 4 };

export const PINNED_SIZE: Size = { w: 4, h: 4 };

function query(
  title: string,
  config: Omit<QueryWidgetConfig, "v" | "kind" | "title" | "color" | "format">,
  color: QueryWidgetConfig["color"] = "chart-1",
): QueryWidgetConfig {
  return { v: 1, kind: "query", title, color, format: "auto", ...config };
}

function system(
  systemId: SystemWidgetConfig["systemId"],
  extra: Partial<Pick<SystemWidgetConfig, "rows" | "period">> = {},
): SystemWidgetConfig {
  return {
    v: 1,
    kind: "system",
    systemId,
    title: G[systemId],
    color: "chart-1",
    format: "auto",
    ...extra,
  };
}

export const PINNED_WIDGET: SystemWidgetConfig = system("due_alerts", { rows: 5 });

// R-22: 13 query widgets and 9 system ones, 20 from DSH-020 and two carried over.
export const WIDGET_GALLERY: GalleryItem[] = [
  {
    id: "invoiced_this_year",
    size: NUMBER,
    config: query(G.invoicedThisYear, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      period: "this_year",
      display: "number",
    }),
  },
  {
    id: "income_this_year",
    size: NUMBER,
    config: query(G.incomeThisYear, {
      source: "payments",
      metric: "sum",
      period: "this_year",
      display: "number",
    }),
  },
  {
    id: "outstanding",
    size: NUMBER,
    config: query(G.outstanding, {
      source: "invoices",
      metric: "sum",
      measure: "outstanding",

      display: "number",
    }),
  },
  {
    id: "overdue",
    size: NUMBER,
    config: query(
      G.overdue,
      {
        source: "invoices",
        metric: "sum",
        measure: "overdue",

        display: "number",
      },
      "chart-4",
    ),
  },
  {
    id: "revenue_by_month",
    size: CHART,
    config: query(G.revenueByMonth, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "month",
      period: "last_12_months",
      display: "bar",
    }),
  },
  {
    id: "revenue_by_quarter",
    size: CHART,
    config: query(G.revenueByQuarter, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "quarter",
      period: "this_year",
      display: "bar",
    }),
  },
  {
    id: "year_over_year",
    size: CHART,
    config: query(G.yearOverYear, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "month",
      period: "this_year",
      compare: "year",
      display: "bar",
    }),
  },
  {
    id: "top_customers",
    size: LIST,
    config: query(G.topCustomers, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "customer",
      period: "this_year",
      topN: 5,
      display: "table",
    }),
  },
  {
    id: "top_items",
    size: LIST,
    config: query(G.topItems, {
      source: "lines",
      metric: "sum",
      groupBy: "item",
      period: "this_year",
      topN: 5,
      display: "table",
    }),
  },
  {
    id: "payment_days",
    size: NUMBER,
    config: query(G.paymentDays, {
      source: "invoices",
      metric: "days_to_pay",
      period: "last_12_months",
      display: "number",
    }),
  },
  {
    id: "currency_shares",
    size: LIST,
    config: query(G.currencyShares, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "currency",
      period: "this_year",
      display: "donut",
    }),
  },
  {
    id: "cumulative",
    size: CHART,
    config: query(G.cumulative, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "month",
      period: "this_year",
      cumulative: true,
      display: "area",
    }),
  },
  {
    id: "heatmap",
    size: CHART,
    config: query(G.heatmap, {
      source: "invoices",
      metric: "sum",
      measure: "invoiced",
      groupBy: "day",
      period: "last_12_months",
      display: "heatmap",
    }),
  },
  { id: "paid_ratio", size: LIST, config: system("paid_ratio", { period: "this_year" }) },
  { id: "aging", size: LIST, config: system("aging") },
  { id: "due_alerts", size: PINNED_SIZE, config: PINNED_WIDGET },
  { id: "upcoming_recurring", size: LIST, config: system("upcoming_recurring", { rows: 5 }) },
  { id: "forecast", size: CHART, config: system("forecast") },
  { id: "unmatched_payments", size: LIST, config: system("unmatched_payments", { rows: 5 }) },
  { id: "limits", size: LIST, config: system("limits") },
  { id: "open_advances", size: LIST, config: system("open_advances", { rows: 5 }) },
  { id: "automation_status", size: LIST, config: system("automation_status") },
];

function placed(id: string, x: number, y: number): WidgetDraft {
  const item = WIDGET_GALLERY.find((entry) => entry.id === id)!;
  return { config: item.config, x, y, ...item.size };
}

export const DEFAULT_DASHBOARD: { name: string; widgets: WidgetDraft[] } = {
  name: TEXTS.dashboard.defaultName,
  widgets: [
    placed("invoiced_this_year", 0, 0),
    placed("income_this_year", 3, 0),
    placed("outstanding", 6, 0),
    placed("overdue", 9, 0),
    placed("due_alerts", 0, 2),
    placed("top_customers", 4, 2),
    placed("payment_days", 8, 2),
    placed("revenue_by_month", 0, 6),
    placed("year_over_year", 6, 6),
  ],
};

export function defaultSize(config: WidgetConfig): Size {
  const match = WIDGET_GALLERY.find(
    (entry) =>
      entry.config.kind === config.kind &&
      (config.kind === "system"
        ? entry.config.kind === "system" && entry.config.systemId === config.systemId
        : entry.config.kind === "query" && entry.config.display === config.display),
  );
  if (match) return match.size;
  return config.kind === "query" && config.display.startsWith("number") ? NUMBER : CHART;
}
