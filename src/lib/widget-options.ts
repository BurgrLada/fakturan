import { CURRENCIES } from "./currency";
import { PERIOD_TOKENS } from "./report-period";
import {
  CATEGORY_GROUPS,
  WIDGET_DISPLAYS,
  WIDGET_MEASURES,
  WIDGET_METRICS,
  WIDGET_SOURCES,
  widgetConfigSchema,
  type QueryWidgetConfig,
} from "./widget-config";

// The configurator offers a value only when the schema accepts the widget with it, after the
// other fields give way. The schema stays the one rule; nothing here duplicates its checks.

type Filters = NonNullable<QueryWidgetConfig["filters"]>;
type FilterKey = keyof Filters;
type Value = string | number | boolean | undefined;

const PLAIN_FIELDS = [
  "source",
  "metric",
  "measure",
  "display",
  "groupBy",
  "splitBy",
  "period",
  "compare",
  "cumulative",
  "topN",
] as const;
const FILTER_KEYS = ["currency", "includeExternal", "status", "customerIds", "type"] as const;

type PlainField = (typeof PLAIN_FIELDS)[number];
export type QueryField = PlainField | `filter:${FilterKey}`;

export const QUERY_FIELDS: readonly QueryField[] = [
  ...PLAIN_FIELDS,
  "filter:currency",
  "filter:includeExternal",
];

const TIME_FIRST = ["month", "quarter", "year", "week", "day"] as const;
const DEFAULT_TOP_N = 5;

const CANDIDATES: Record<QueryField, readonly Value[]> = {
  source: WIDGET_SOURCES,
  metric: WIDGET_METRICS,
  measure: [...WIDGET_MEASURES, undefined],
  display: WIDGET_DISPLAYS,
  groupBy: [undefined, ...TIME_FIRST, ...CATEGORY_GROUPS],
  splitBy: [undefined, ...CATEGORY_GROUPS],
  period: [undefined, "this_year", ...PERIOD_TOKENS.filter((token) => token !== "this_year")],
  compare: [undefined, "previous", "year"],
  cumulative: [undefined, true],
  topN: [undefined, DEFAULT_TOP_N],
  "filter:currency": [undefined, ...CURRENCIES],
  "filter:includeExternal": [undefined, false],
  // Kept when valid and dropped when not; the configurator has no input for them.
  "filter:status": [undefined],
  "filter:customerIds": [undefined],
  "filter:type": [undefined],
};

function filterKey(field: QueryField): FilterKey | null {
  return field.startsWith("filter:") ? (field.slice(7) as FilterKey) : null;
}

export function getQueryField(config: QueryWidgetConfig, field: QueryField): unknown {
  const key = filterKey(field);
  return key ? config.filters?.[key] : config[field as PlainField];
}

function assign(config: QueryWidgetConfig, field: QueryField, value: unknown): QueryWidgetConfig {
  const key = filterKey(field);
  if (key) {
    const filters: Record<string, unknown> = { ...config.filters };
    if (value === undefined) delete filters[key];
    else filters[key] = value;
    const { filters: _filters, ...rest } = config;
    return Object.keys(filters).length === 0 ? rest : { ...rest, filters: filters as Filters };
  }
  const next: Record<string, unknown> = { ...config };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next as QueryWidgetConfig;
}

function fieldOf(path: PropertyKey[]): QueryField | null {
  const [head, key] = path;
  if (head === "filters") {
    return (FILTER_KEYS as readonly unknown[]).includes(key)
      ? (`filter:${String(key)}` as QueryField)
      : null;
  }
  return (PLAIN_FIELDS as readonly unknown[]).includes(head) ? (head as PlainField) : null;
}

// Title and other free fields are left to the form, so only fields with choices count here.
function brokenFields(config: QueryWidgetConfig): QueryField[] {
  const parsed = widgetConfigSchema.safeParse(config);
  if (parsed.success) return [];
  const fields = parsed.error.issues.flatMap((issue) => fieldOf(issue.path) ?? []);
  return [...new Set(fields)];
}

const MAX_STEPS = 24;

function repaired(config: QueryWidgetConfig, pinned: QueryField): QueryWidgetConfig | null {
  let current = config;
  for (let step = 0; step < MAX_STEPS; step++) {
    const broken = brokenFields(current);
    if (broken.length === 0) return current;
    const target = broken.find((field) => field !== pinned);
    if (!target) return null;
    const fixed = CANDIDATES[target]
      .map((value) => assign(current, target, value))
      .find((candidate) => !brokenFields(candidate).includes(target));
    if (!fixed) return null;
    current = fixed;
  }
  return null;
}

// Value labels sit on the marks, so they fit a single bar series, lines and areas only.
export function labelsAllowed(config: QueryWidgetConfig): boolean {
  if (config.display === "line" || config.display === "area") return true;
  return config.display === "bar" && !config.compare && !config.splitBy;
}

function withLabels(config: QueryWidgetConfig): QueryWidgetConfig {
  if (config.labels === undefined || labelsAllowed(config)) return config;
  const { labels: _labels, ...rest } = config;
  return rest;
}

export function queryOptions(config: QueryWidgetConfig, field: QueryField): Value[] {
  return CANDIDATES[field].filter(
    (value) => repaired(assign(config, field, value), field) !== null,
  );
}

// An invalid choice leaves the widget as it was, so a stale select never breaks the form.
export function setQueryField(
  config: QueryWidgetConfig,
  field: QueryField,
  value: unknown,
): QueryWidgetConfig {
  const next = repaired(assign(config, field, value), field);
  return next ? withLabels(next) : config;
}
