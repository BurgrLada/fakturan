import "server-only";
import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { GlobalFilter } from "@/lib/dashboard-filter";
import { isCalendarDate, type CalendarDate } from "@/lib/number-format";
import {
  bucketsBetween,
  comparisonRange,
  previousRange,
  resolvePeriod,
  type BucketUnit,
  type DateRange,
} from "@/lib/report-period";
import { TEXTS } from "@/lib/texts";
import {
  isAdditive,
  isBucketUnit,
  MAX_BUCKETS,
  MAX_PERIOD_YEARS,
  MAX_TOP_N,
  parseWidgetConfig,
  rangeTooLong,
  tooManyBuckets,
  WidgetConfigError,
  type CategoryGroup,
  type QueryWidgetConfig,
  type SystemWidgetConfig,
  type SystemWidgetId,
  type WidgetConfig,
  type WidgetMetric,
} from "@/lib/widget-config";
import { dueSql, overdueCondition } from "../db/invoice-sql";
import { customer, invoice, invoiceLine, payment } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError, type Reader } from "../services/access";
import { alignPrevious, spanSeries } from "./align";
import * as core from "./queries";
import type { SystemDetail } from "./system-widgets";
import type { ReportFilter, Unconverted } from "./types";

const C = TEXTS.dashboard.config;

export type WidgetContext = {
  today: CalendarDate;
  // The dashboard filter in the URL (R-21): its period wins, its currency intersects.
  globalFilter?: GlobalFilter;
};

export type WidgetPoint = { key: string; value: number | null };
export type RowKind = "row" | "others" | "adjustment";
export type WidgetSeries = { key: string; name: string; kind: RowKind; points: WidgetPoint[] };
export type WidgetRow = { kind: RowKind; key: string; name: string; value: number | null };
export type WidgetCompare = {
  range: DateRange;
  total: number | null;
  delta: number | null;
  // Previous buckets paired with the current ones, as on the Statistics page.
  points?: number[];
};
export type WidgetResult = {
  kind: "total" | "series" | "rows" | "system";
  series: WidgetSeries[];
  rows: WidgetRow[];
  total: number | null;
  compare?: WidgetCompare;
  range: DateRange;
  unconverted: Unconverted;
  // A median, average, minimum or maximum cannot fold into "Ostatní", so rows past 50 are dropped.
  truncated?: true;
  // What a system widget shows beyond numbers, such as the rows of the due alerts card.
  detail?: SystemDetail;
};

export type SystemWidgetRunner = (
  q: core.SnapshotReader & Reader,
  ownerId: string,
  config: SystemWidgetConfig,
  context: WidgetContext,
) => WidgetResult;

// Filled by the overview (Task 6); an unregistered system widget is an error, never a blank card.
export const SYSTEM_WIDGET_RUNNERS: Partial<Record<SystemWidgetId, SystemWidgetRunner>> = {};

type Fields = Record<string, SQL>;
type Row = Record<string, unknown>;
type Dimension = { key: SQL<string>; name?: SQL<string> };

type Plan = {
  where: SQL;
  value: SQL | null;
  date: SQL | SQLiteColumn;
  dims: Partial<Record<CategoryGroup, Dimension>>;
  rows: (fields: Fields, groupBy: SQL[], having?: SQL) => Row[];
  unconverted: () => Unconverted;
};

const customerDim: Dimension = {
  key: sql<string>`coalesce(${invoice.customerId}, '')`,
  name: sql<string>`max(${invoice.customerName})`,
};
const statusDim: Dimension = { key: sql<string>`${invoice.status}` };
const typeDim: Dimension = { key: sql<string>`${invoice.type}` };

function invoiceConditions(config: QueryWidgetConfig): (SQL | undefined)[] {
  const { status, type } = config.filters ?? {};
  return [
    status ? inArray(invoice.status, status) : undefined,
    type ? inArray(invoice.type, type) : undefined,
  ];
}

type Grouped = { having: (condition: SQL) => { all: () => Row[] }; all: () => Row[] };

function grouped(
  base: (fields: Fields) => { groupBy: (...keys: SQL[]) => Grouped; all: () => Row[] },
) {
  return (fields: Fields, groupBy: SQL[], having?: SQL): Row[] => {
    if (groupBy.length === 0) return base(fields).all();
    const rows = base(fields).groupBy(...groupBy);
    return having ? rows.having(having).all() : rows.all();
  };
}

function invoicesPlan(
  q: Reader,
  ownerId: string,
  config: QueryWidgetConfig,
  filter: ReportFilter,
  today: CalendarDate,
): Plan {
  const measure = config.measure ?? "invoiced";
  const condition = {
    invoiced: and(core.documentFilter(q, ownerId, filter), core.notAdvance),
    outstanding: and(core.stateFilter(q, ownerId, filter), core.outstanding),
    overdue: and(core.stateFilter(q, ownerId, filter), overdueCondition(today), core.notAdvance),
  }[measure];
  const where = and(condition, ...invoiceConditions(config)) as SQL;
  const amount = measure === "invoiced" ? invoice.totalMinor : dueSql;
  return {
    where,
    value: core.documentMoney(filter, amount),
    date: invoice.issueDate,
    dims: {
      customer: customerDim,
      currency: { key: sql<string>`${invoice.currency}` },
      status: statusDim,
      type: typeDim,
    },
    rows: grouped((fields) => q.select(fields).from(invoice).where(where).$dynamic()),
    unconverted: () => core.documentsUnconverted(q, where, amount, !filter.currency),
  };
}

// Advances are left out, as in the items overview, or their lines would count twice (R-10).
function linesPlan(q: Reader, ownerId: string, config: QueryWidgetConfig, filter: ReportFilter) {
  const where = and(
    core.documentFilter(q, ownerId, filter),
    core.notAdvance,
    ...invoiceConditions(config),
  ) as SQL;
  const plan: Plan = {
    where,
    value: core.documentMoney(filter, invoiceLine.netMinor),
    date: invoice.issueDate,
    dims: {
      customer: customerDim,
      item: {
        key: sql<string>`coalesce('item:' || ${invoiceLine.catalogItemId}, 'name:' || ${invoiceLine.name})`,
        name: sql<string>`max(${invoiceLine.name})`,
      },
      currency: { key: sql<string>`${invoice.currency}` },
      status: statusDim,
      type: typeDim,
    },
    rows: grouped((fields) =>
      q
        .select(fields)
        .from(invoiceLine)
        .innerJoin(invoice, eq(invoice.id, invoiceLine.invoiceId))
        .where(and(scoped(ownerId).where(invoiceLine), where))
        .$dynamic(),
    ),
    unconverted: () => core.documentsUnconverted(q, where, invoice.totalMinor, !filter.currency),
  };
  return plan;
}

function paymentsPlan(q: Reader, ownerId: string, config: QueryWidgetConfig, filter: ReportFilter) {
  const { type } = config.filters ?? {};
  const where = and(
    core.paymentFilter(q, ownerId, filter),
    type ? inArray(invoice.type, type) : undefined,
  ) as SQL;
  const plan: Plan = {
    where,
    value: core.paymentMoney(filter),
    date: payment.paidOn,
    dims: {
      customer: customerDim,
      currency: { key: sql<string>`${payment.currency}` },
      type: typeDim,
    },
    rows: grouped((fields) =>
      q
        .select(fields)
        .from(payment)
        .innerJoin(invoice, eq(invoice.id, payment.invoiceId))
        .where(where)
        .$dynamic(),
    ),
    unconverted: () => core.paymentsUnconverted(q, where, filter),
  };
  return plan;
}

// A customer belongs to the Prague day it was created on, like every other date in reports.
function customersPlan(q: Reader, ownerId: string, filter: ReportFilter): Plan {
  const date = sql<string>`prague_date(${customer.createdAt})`;
  const where = scoped(ownerId).where(customer, () =>
    and(gte(date, filter.range.from), lte(date, filter.range.to)),
  );
  return {
    where,
    value: null,
    date,
    dims: {},
    rows: grouped((fields) => q.select(fields).from(customer).where(where).$dynamic()),
    unconverted: () => core.NOTHING,
  };
}

function planFor(
  q: Reader,
  ownerId: string,
  config: QueryWidgetConfig,
  filter: ReportFilter,
  today: CalendarDate,
): Plan {
  switch (config.source) {
    case "invoices":
      return invoicesPlan(q, ownerId, config, filter, today);
    case "lines":
      return linesPlan(q, ownerId, config, filter);
    case "payments":
      return paymentsPlan(q, ownerId, config, filter);
    case "customers":
      return customersPlan(q, ownerId, filter);
    default:
      throw new ServiceError(TEXTS.dashboard.errors.invalid);
  }
}

// Half away from zero, like every other rounding of money.
function average(sum: number, count: number): number | null {
  if (count === 0) return null;
  const s = BigInt(sum);
  const n = BigInt(count);
  const magnitude = (BigInt(2) * (s < BigInt(0) ? -s : s) + n) / (BigInt(2) * n);
  return Number(s < BigInt(0) ? -magnitude : magnitude);
}

function metricFields(metric: WidgetMetric, value: SQL | null): Fields {
  if (metric === "count" || value === null) return { n: sql`count(*)` };
  switch (metric) {
    case "sum":
      return { s: sql`coalesce(sum(${value}), 0)` };
    case "avg":
      return { s: sql`coalesce(sum(${value}), 0)`, n: sql`count(${value})` };
    case "median":
      return { m: sql`median_minor(${value})` };
    case "min":
      return { m: sql`min(${value})` };
    case "max":
      return { m: sql`max(${value})` };
    default:
      throw new ServiceError(TEXTS.dashboard.errors.invalid);
  }
}

function readMetric(metric: WidgetMetric, row: Row | undefined): number | null {
  if (!row) return isAdditive(metric) ? 0 : null;
  const number = (key: string) => (row[key] == null ? null : Number(row[key]));
  switch (metric) {
    case "count":
      return number("n") ?? 0;
    case "sum":
      return number("s") ?? 0;
    case "avg":
      return average(number("s") ?? 0, number("n") ?? 0);
    default:
      return number("m");
  }
}

type Computed = {
  total: number | null;
  series: WidgetSeries[];
  rows: WidgetRow[];
  truncated?: true;
};

function ranked<T extends { kind: RowKind; key: string; name: string }>(
  items: (T & { value: number | null })[],
  limit: number,
  additive: boolean,
  merge: (rest: (T & { value: number | null })[]) => T & { value: number | null },
) {
  if (!additive || items.length <= limit) return items.slice(0, MAX_TOP_N);
  return [...items.slice(0, limit), merge(items.slice(limit))];
}

function byValue(a: { value: number | null; name: string; key: string }, b: typeof a): number {
  if (a.value !== b.value) return (b.value ?? -Infinity) - (a.value ?? -Infinity);
  return a.name.localeCompare(b.name, "cs") || a.key.localeCompare(b.key);
}

function timeSeries(plan: Plan, config: QueryWidgetConfig, range: DateRange, unit: BucketUnit) {
  const keys = bucketsBetween(range, unit);
  const additive = isAdditive(config.metric);
  const bucket = sql<string>`date_bucket(${plan.date}, ${unit})`;
  const fields = metricFields(config.metric, plan.value);
  const empty = additive ? 0 : null;
  const fill = (rows: Row[]): WidgetPoint[] => {
    const values = new Map(
      rows.map((row) => [row.bucket as string, readMetric(config.metric, row)]),
    );
    const points = keys.map((key) => ({ key, value: values.get(key) ?? empty }));
    if (!config.cumulative) return points;
    let running = 0;
    return points.map((point) => ({ ...point, value: (running += point.value ?? 0) }));
  };
  const split = config.splitBy ? plan.dims[config.splitBy] : undefined;
  if (!split) {
    const rows = plan.rows({ bucket, ...fields }, [bucket]);
    return [{ key: "value", name: "", kind: "row" as const, points: fill(rows) }];
  }
  const rows = plan.rows(
    { bucket, split: split.key, ...(split.name && { name: split.name }), ...fields },
    [bucket, split.key],
  );
  const groups = new Map<string, { name: string; rows: Row[] }>();
  for (const row of rows) {
    const key = row.split as string;
    const group = groups.get(key) ?? { name: (row.name as string | undefined) ?? key, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const series = [...groups].map(([key, group]) => {
    const points = fill(group.rows);
    const value = points.reduce((sum, point) => sum + (point.value ?? 0), 0);
    return { key, name: group.name, kind: "row" as RowKind, points, value };
  });
  series.sort(byValue);
  return ranked(series, config.topN ?? MAX_TOP_N, true, (rest) => {
    const points = keys.map((key, index) => ({
      key,
      value: rest.reduce((sum, item) => sum + (item.points[index]!.value ?? 0), 0),
    }));
    return { key: "others", name: "", kind: "others" as RowKind, points, value: 0 };
  }).map(({ value: _value, ...item }) => item);
}

function categoryRows(
  plan: Plan,
  config: QueryWidgetConfig,
  group: CategoryGroup,
): { rows: WidgetRow[]; truncated: boolean } {
  const dim = plan.dims[group];
  if (!dim) throw new ServiceError(TEXTS.dashboard.errors.invalid);
  const fields = metricFields(config.metric, plan.value);
  // A group whose every amount lacks a rate has no value, only unconverted ones, as on Statistics.
  const valued =
    plan.value && config.metric !== "count" ? sql`count(${plan.value}) > 0` : undefined;
  const rows = plan
    .rows({ key: dim.key, ...(dim.name && { name: dim.name }), ...fields }, [dim.key], valued)
    .map((row) => ({
      kind: "row" as RowKind,
      key: row.key as string,
      name: (row.name as string | null | undefined) ?? (dim.name ? "" : (row.key as string)),
      value: readMetric(config.metric, row),
    }))
    .sort(byValue);
  const additive = isAdditive(config.metric);
  const limited = ranked(rows, config.topN ?? MAX_TOP_N, additive, (rest) => ({
    kind: "others",
    key: "others",
    name: "",
    value: rest.reduce((sum, row) => sum + (row.value ?? 0), 0),
  }));
  return { rows: limited, truncated: !additive && rows.length > MAX_TOP_N };
}

// Lines miss the document discount and rounding, so the item table ends with the difference
// against the invoiced amount and adds up to it (R-10).
function itemAdjustment(q: Reader, plan: Plan, filter: ReportFilter, rows: WidgetRow[]): number {
  const invoiced = q
    .select({ s: sql<number>`coalesce(sum(${core.documentMoney(filter, invoice.totalMinor)}), 0)` })
    .from(invoice)
    .where(plan.where)
    .get()!.s;
  return invoiced - rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
}

function compute(
  q: Reader,
  ownerId: string,
  config: QueryWidgetConfig,
  filter: ReportFilter,
  today: CalendarDate,
): Computed & { unconverted: Unconverted } {
  if (config.metric === "days_to_pay") {
    const { averageDays } = core.paymentDays(q, ownerId, filter);
    return { total: averageDays, series: [], rows: [], unconverted: core.NOTHING };
  }
  const plan = planFor(q, ownerId, config, filter, today);
  const fields = metricFields(config.metric, plan.value);
  let total = readMetric(config.metric, plan.rows(fields, [])[0]);
  let series: WidgetSeries[] = [];
  let rows: WidgetRow[] = [];
  let truncated = false;
  const { groupBy } = config;
  if (isBucketUnit(groupBy)) series = timeSeries(plan, config, filter.range, groupBy);
  else if (groupBy) {
    ({ rows, truncated } = categoryRows(plan, config, groupBy));
    if (config.source === "lines" && groupBy === "item" && config.metric === "sum") {
      const adjustment = itemAdjustment(q, plan, filter, rows);
      if (adjustment !== 0) {
        rows.push({ kind: "adjustment", key: "adjustment", name: "", value: adjustment });
        total = (total ?? 0) + adjustment;
      }
    }
  }
  const unconverted = config.metric === "count" ? core.NOTHING : plan.unconverted();
  return { total, series, rows, unconverted, ...(truncated && { truncated: true as const }) };
}

function rangeProblem(range: DateRange, config: QueryWidgetConfig): string | null {
  if (rangeTooLong(range)) return C.periodTooLong(MAX_PERIOD_YEARS);
  if (isBucketUnit(config.groupBy) && tooManyBuckets(range, config.groupBy)) {
    return C.tooManyBuckets(MAX_BUCKETS);
  }
  return null;
}

function isBalance(config: QueryWidgetConfig): boolean {
  return config.measure === "outstanding" || config.measure === "overdue";
}

// A balance is the state as of today: neither its own nor the dashboard period narrows it.
function queryRange(config: QueryWidgetConfig, context: WidgetContext): DateRange {
  if (isBalance(config)) return { from: context.today, to: context.today };
  return resolvePeriod(context.globalFilter?.period ?? config.period!, context.today);
}

// The reason runWidget would refuse the period, checked before the cache so the card can say it.
export function widgetProblem(config: WidgetConfig, context: WidgetContext): string | null {
  if (config.kind !== "query" || isBalance(config)) return null;
  return rangeProblem(queryRange(config, context), config);
}

function asSeries(series: WidgetSeries | undefined) {
  const points = (series?.points ?? []).map((p) => ({ key: p.key, amountMinor: p.value ?? 0 }));
  return { points, unconverted: core.NOTHING };
}

function runQuery(
  q: Reader,
  ownerId: string,
  config: QueryWidgetConfig,
  context: WidgetContext,
): WidgetResult {
  const global = context.globalFilter ?? {};
  const balance = isBalance(config);
  const range = queryRange(config, context);
  const problem = balance ? null : rangeProblem(range, config);
  if (problem) throw new ServiceError(problem);
  const kind = isBucketUnit(config.groupBy) ? "series" : config.groupBy ? "rows" : "total";
  const own = config.filters?.currency;
  if (own && global.currency && own !== global.currency) {
    return { kind, series: [], rows: [], total: null, range, unconverted: core.NOTHING };
  }
  const filter: ReportFilter = {
    range,
    currency: own ?? global.currency,
    includeExternal: config.filters?.includeExternal ?? true,
    customerIds: config.filters?.customerIds,
  };
  const current = compute(q, ownerId, config, filter, context.today);
  const result: WidgetResult = { kind, ...current, range };
  const mode = config.compare ?? (balance || config.splitBy ? undefined : global.compare);
  if (!mode || (config.groupBy && kind === "rows")) return result;

  const before = { ...filter, range: comparisonRange(range, mode, context.today) };
  const previous = compute(q, ownerId, config, before, context.today);
  const delta =
    current.total === null || previous.total === null ? null : current.total - previous.total;
  result.compare = { range: before.range, total: previous.total, delta };
  if (isBucketUnit(config.groupBy) && isAdditive(config.metric) && !config.cumulative) {
    result.compare.points = alignPrevious(
      asSeries(current.series[0]),
      spanSeries(asSeries(previous.series[0]), previousRange(range, mode), config.groupBy),
    );
  }
  return result;
}

function parsed(config: WidgetConfig): WidgetConfig {
  try {
    return parseWidgetConfig(config);
  } catch (error) {
    if (error instanceof WidgetConfigError) throw new ServiceError(error.message);
    throw error;
  }
}

// One deferred read transaction, so every number of a widget comes from the same snapshot.
export function runWidget(
  q: core.SnapshotReader,
  ownerId: string,
  config: WidgetConfig,
  context: WidgetContext,
): WidgetResult {
  if (!isCalendarDate(context.today)) throw new RangeError(`Neplatné datum: ${context.today}`);
  const checked = parsed(config);
  return q.transaction(
    (tx: core.SnapshotReader & Reader) => {
      if (checked.kind === "query") return runQuery(tx, ownerId, checked, context);
      const runner = SYSTEM_WIDGET_RUNNERS[checked.systemId];
      if (!runner) throw new ServiceError(TEXTS.dashboard.errors.systemWidget);
      return runner(tx, ownerId, checked, context);
    },
    { behavior: "deferred" },
  );
}
