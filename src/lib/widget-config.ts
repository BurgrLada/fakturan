import { z } from "zod";
import { CHART_TOKENS } from "./chart-tokens";
import { CURRENCIES } from "./currency";
import { INVOICE_STATUSES, INVOICE_TYPES } from "./invoice";
import { isCalendarDate } from "./number-format";
import {
  BUCKET_UNITS,
  bucketsBetween,
  PERIOD_TOKENS,
  type BucketUnit,
  type DateRange,
} from "./report-period";
import { TEXTS } from "./texts";
import { czechError, firstIssue } from "./validation-issue";

// Declarative only (DSH-018): every field is an enum, a number or a date, so nothing in a widget
// can name a column, an expression or code. The server maps each value to its own SQL.

const C = TEXTS.dashboard.config;

export const WIDGET_CONFIG_VERSION = 1;

export const WIDGET_SOURCES = ["invoices", "lines", "payments", "customers"] as const;
export const WIDGET_METRICS = [
  "sum",
  "count",
  "avg",
  "median",
  "min",
  "max",
  "days_to_pay",
] as const;
export const WIDGET_MEASURES = ["invoiced", "outstanding", "overdue"] as const;
export const CATEGORY_GROUPS = ["customer", "item", "currency", "status", "type"] as const;
export const WIDGET_GROUPS = [...BUCKET_UNITS, ...CATEGORY_GROUPS] as const;
export const WIDGET_DISPLAYS = [
  "number",
  "number_compare",
  "table",
  "bar",
  "stacked_bar",
  "line",
  "area",
  "donut",
  "heatmap",
] as const;
export const WIDGET_FORMATS = ["auto", "whole", "thousands"] as const;
export const WIDGET_FILTERS = [
  "status",
  "customerIds",
  "currency",
  "type",
  "includeExternal",
] as const;
export const SYSTEM_WIDGET_IDS = [
  "paid_ratio",
  "aging",
  "due_alerts",
  "upcoming_recurring",
  "forecast",
  "unmatched_payments",
  "limits",
  "open_advances",
  "automation_status",
] as const;
// Drafts and cancelled documents never reach an amount, so a filter cannot ask for them.
export const FILTER_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== "draft" && status !== "cancelled",
) as [Exclude<(typeof INVOICE_STATUSES)[number], "draft" | "cancelled">, ...never[]];

export const MAX_PERIOD_YEARS = 10;
export const MAX_BUCKETS = 400;
export const MAX_TOP_N = 50;
export const MAX_CUSTOMER_FILTER = 50;

export type WidgetSource = (typeof WIDGET_SOURCES)[number];
export type WidgetMetric = (typeof WIDGET_METRICS)[number];
export type WidgetMeasure = (typeof WIDGET_MEASURES)[number];
export type WidgetGroup = (typeof WIDGET_GROUPS)[number];
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];
export type WidgetFilter = (typeof WIDGET_FILTERS)[number];
export type SystemWidgetId = (typeof SYSTEM_WIDGET_IDS)[number];

type SourceFields = {
  metrics: readonly WidgetMetric[];
  measures: readonly WidgetMeasure[];
  groupBy: readonly WidgetGroup[];
  filters: readonly WidgetFilter[];
};

export const SOURCE_FIELDS: Record<WidgetSource, SourceFields> = {
  invoices: {
    metrics: WIDGET_METRICS,
    measures: WIDGET_MEASURES,
    groupBy: [...BUCKET_UNITS, "customer", "currency", "status", "type"],
    filters: WIDGET_FILTERS,
  },
  lines: {
    metrics: ["sum", "count", "avg", "median", "min", "max"],
    measures: [],
    groupBy: WIDGET_GROUPS,
    filters: WIDGET_FILTERS,
  },
  payments: {
    metrics: ["sum", "count", "avg", "median", "min", "max"],
    measures: [],
    groupBy: [...BUCKET_UNITS, "customer", "currency", "type"],
    filters: ["customerIds", "currency", "type", "includeExternal"],
  },
  customers: {
    metrics: ["count"],
    measures: [],
    groupBy: BUCKET_UNITS,
    filters: [],
  },
};

const ADDITIVE: readonly WidgetMetric[] = ["sum", "count"];
const DAYS_TO_PAY_FILTERS: readonly WidgetFilter[] = ["customerIds", "currency", "includeExternal"];

export function isBucketUnit(group: WidgetGroup | undefined): group is BucketUnit {
  return (BUCKET_UNITS as readonly string[]).includes(group ?? "");
}

export function isAdditive(metric: WidgetMetric): boolean {
  return ADDITIVE.includes(metric);
}

const dateSchema = z.string().refine(isCalendarDate, C.invalidDate);

export const periodSchema = z.union([
  z.enum(PERIOD_TOKENS),
  z
    .strictObject({ from: dateSchema, to: dateSchema })
    .refine((range) => range.from <= range.to, C.reversedPeriod),
]);

const filtersSchema = z.strictObject({
  status: z.array(z.enum(FILTER_STATUSES)).min(1).max(FILTER_STATUSES.length).optional(),
  customerIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_CUSTOMER_FILTER).optional(),
  currency: z.enum(CURRENCIES).optional(),
  type: z.array(z.enum(INVOICE_TYPES)).min(1).max(INVOICE_TYPES.length).optional(),
  includeExternal: z.boolean().optional(),
});

const common = {
  v: z.literal(WIDGET_CONFIG_VERSION),
  title: z.string().trim().max(80),
  color: z.enum(CHART_TOKENS),
  format: z.enum(WIDGET_FORMATS),
  labels: z.boolean().optional(),
};

const queryWidgetSchema = z.strictObject({
  ...common,
  kind: z.literal("query"),
  source: z.enum(WIDGET_SOURCES),
  metric: z.enum(WIDGET_METRICS),
  measure: z.enum(WIDGET_MEASURES).optional(),
  groupBy: z.enum(WIDGET_GROUPS).optional(),
  splitBy: z.enum(CATEGORY_GROUPS).optional(),
  filters: filtersSchema.optional(),
  period: periodSchema.optional(),
  compare: z.enum(["previous", "year"]).optional(),
  display: z.enum(WIDGET_DISPLAYS),
  cumulative: z.boolean().optional(),
  topN: z.int().min(1).max(MAX_TOP_N).optional(),
});

const systemWidgetSchema = z.strictObject({
  ...common,
  kind: z.literal("system"),
  systemId: z.enum(SYSTEM_WIDGET_IDS),
  rows: z.int().min(1).max(MAX_TOP_N).optional(),
  period: periodSchema.optional(),
});

export type QueryWidgetConfig = z.infer<typeof queryWidgetSchema>;
export type SystemWidgetConfig = z.infer<typeof systemWidgetSchema>;

// The day after `to`, ten years back, is the earliest allowed start, so ten full years pass.
export function rangeTooLong(range: DateRange): boolean {
  const [year, month, day] = range.to.split("-").map(Number) as [number, number, number];
  const earliest = new Date(Date.UTC(year - MAX_PERIOD_YEARS, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
  return range.from < earliest;
}

export function tooManyBuckets(range: DateRange, unit: BucketUnit): boolean {
  return bucketsBetween(range, unit).length > MAX_BUCKETS;
}

type Issue = { path: (string | number)[]; message: string };

function queryIssues(config: QueryWidgetConfig): Issue[] {
  const issues: Issue[] = [];
  const fail = (path: (string | number)[], message: string) => issues.push({ path, message });
  const fields = SOURCE_FIELDS[config.source];
  const { metric, measure, groupBy, splitBy, display } = config;
  const time = isBucketUnit(groupBy);
  const category = groupBy !== undefined && !time;

  if (!fields.metrics.includes(metric)) fail(["metric"], C.metric);
  if (measure && !fields.measures.includes(measure)) fail(["measure"], C.measure);
  if (groupBy && !fields.groupBy.includes(groupBy)) fail(["groupBy"], C.groupBy);
  if (splitBy && !fields.groupBy.includes(splitBy)) fail(["splitBy"], C.splitBy);
  for (const key of Object.keys(config.filters ?? {}) as WidgetFilter[]) {
    if (!fields.filters.includes(key)) fail(["filters", key], C.filter);
  }

  const balance = measure === "outstanding" || measure === "overdue";
  if (balance && time) fail(["groupBy"], C.balanceTime);
  if (balance && config.compare) fail(["compare"], C.balanceCompare);

  if (metric === "days_to_pay") {
    if (measure && measure !== "invoiced") fail(["measure"], C.daysMeasure);
    if (groupBy) fail(["groupBy"], C.daysGroup);
    for (const key of Object.keys(config.filters ?? {}) as WidgetFilter[]) {
      if (!DAYS_TO_PAY_FILTERS.includes(key)) fail(["filters", key], C.daysFilter);
    }
  }
  if (!isAdditive(metric)) {
    if (splitBy) fail(["splitBy"], C.additiveSplit);
    if (config.topN !== undefined) fail(["topN"], C.additiveTop);
    if (config.cumulative) fail(["cumulative"], C.additiveCumulative);
  }

  if (splitBy) {
    if (!time) fail(["splitBy"], C.splitTime);
    if (config.compare) fail(["compare"], C.splitCompare);
  }
  if (display === "stacked_bar" && !splitBy) fail(["splitBy"], C.stackedSplit);
  if (config.compare && category) fail(["compare"], C.compareCategory);
  if (config.topN !== undefined && !category && !splitBy) {
    fail(["topN"], C.topCategory);
  }
  if (config.cumulative) {
    if (display !== "line" && display !== "area") fail(["cumulative"], C.cumulativeDisplay);
    if (!time) fail(["cumulative"], C.cumulativeTime);
  }
  if (display === "heatmap" && groupBy !== "day") fail(["groupBy"], C.heatmapDay);
  if ((display === "number" || display === "number_compare") && groupBy) {
    fail(["groupBy"], C.numberGroup);
  }
  if (display === "number_compare" && !config.compare) fail(["compare"], C.compareMissing);
  if (display === "donut" && !category) fail(["groupBy"], C.donutCategory);
  if (["bar", "stacked_bar", "line", "area"].includes(display) && !groupBy) {
    fail(["groupBy"], C.chartGroup);
  }

  if (typeof config.period === "object") {
    if (rangeTooLong(config.period)) fail(["period"], C.periodTooLong(MAX_PERIOD_YEARS));
    else if (time && tooManyBuckets(config.period, groupBy)) {
      fail(["groupBy"], C.tooManyBuckets(MAX_BUCKETS));
    }
  }
  if (balance && config.period !== undefined) fail(["period"], C.balancePeriod);
  if (!balance && config.period === undefined) fail(["period"], C.periodMissing);
  return issues;
}

export const widgetConfigSchema = z
  .discriminatedUnion("kind", [queryWidgetSchema, systemWidgetSchema])
  .superRefine((config, ctx) => {
    if (config.kind !== "query") {
      if (typeof config.period === "object" && rangeTooLong(config.period)) {
        ctx.addIssue({
          code: "custom",
          path: ["period"],
          message: C.periodTooLong(MAX_PERIOD_YEARS),
        });
      }
      return;
    }
    for (const issue of queryIssues(config)) ctx.addIssue({ code: "custom", ...issue });
  });

export type WidgetConfig = z.infer<typeof widgetConfigSchema>;

export class WidgetConfigError extends Error {
  path: string;

  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.path = path;
  }
}

export function parseWidgetConfig(raw: unknown): WidgetConfig {
  const parsed = widgetConfigSchema.safeParse(raw, { error: czechError });
  if (parsed.success) return parsed.data;
  const { path, message } = firstIssue(parsed.error);
  throw new WidgetConfigError(path, message);
}

export function isPinnedWidget(config: WidgetConfig): boolean {
  return config.kind === "system" && config.systemId === "due_alerts";
}
