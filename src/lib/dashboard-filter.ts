import { z } from "zod";
import { CURRENCIES, type Currency } from "./currency";
import { isCalendarDate, type CalendarDate } from "./number-format";
import { COMPARE_MODES, COMPARE_PARAM, CUSTOM_PERIOD, PERIOD_PARAM } from "./report-filter";
import {
  PERIOD_TOKENS,
  resolvePeriod,
  type CompareMode,
  type DateRange,
  type Period,
  type PeriodToken,
} from "./report-period";
import { periodSchema, rangeTooLong, type WidgetConfig } from "./widget-config";

// R-21: nothing set means every widget keeps its own period, currency and comparison.
export type GlobalFilter = { period?: Period; currency?: Currency; compare?: CompareMode };

export const DASHBOARD_PARAM = "dashboard";

type RawParams = Record<string, string | string[] | undefined>;

const keyOf = <K extends string>(map: Record<K, string>, value: string | undefined) =>
  (Object.keys(map) as K[]).find((key) => map[key] === value);

function tokenFor(range: DateRange, today: CalendarDate): PeriodToken | undefined {
  return PERIOD_TOKENS.find((token) => {
    const resolved = resolvePeriod(token, today);
    return resolved.from === range.from && resolved.to === range.to;
  });
}

function customRange(from: string | undefined, to: string | undefined): DateRange | undefined {
  if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || from > to) return undefined;
  const range = { from, to };
  return rangeTooLong(range) ? undefined : range;
}

// Query strings are untrusted: a value that does not fit is dropped and the widget's own applies.
export function parseDashboardFilter(params: RawParams, today: CalendarDate): GlobalFilter {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const raw = one("obdobi");
  const range = raw === CUSTOM_PERIOD ? customRange(one("od"), one("do")) : undefined;
  const period: Period | undefined =
    keyOf(PERIOD_PARAM, raw) ?? (range && (tokenFor(range, today) ?? range));
  const currency = CURRENCIES.find((code) => code === one("mena"));
  const compare = keyOf(COMPARE_PARAM, one("porovnani"));
  return {
    ...(period && { period }),
    ...(currency && { currency }),
    ...(compare && { compare }),
  };
}

export function dashboardFilterParams(filter: GlobalFilter): Record<string, string> {
  const { period, currency, compare } = filter;
  return {
    ...(typeof period === "string" && { obdobi: PERIOD_PARAM[period] }),
    ...(typeof period === "object" && { obdobi: CUSTOM_PERIOD, od: period.from, do: period.to }),
    ...(currency && { mena: currency }),
    ...(compare && { porovnani: COMPARE_PARAM[compare] }),
  };
}

export function dashboardHref(dashboardId: string | null, filter: GlobalFilter): string {
  const params = new URLSearchParams({
    ...(dashboardId && { [DASHBOARD_PARAM]: dashboardId }),
    ...dashboardFilterParams(filter),
  });
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

const filterSchema = z.strictObject({
  period: periodSchema.optional(),
  currency: z.enum(CURRENCIES).optional(),
  compare: z.enum(COMPARE_MODES).optional(),
});

// The cache key of one widget. The config is checked again by runWidget, the filter here.
export function widgetQuery(config: WidgetConfig, filter: GlobalFilter): string {
  return JSON.stringify({ config, filter });
}

export function parseWidgetQuery(query: string): { config: unknown; filter: GlobalFilter } {
  const parsed = z
    .strictObject({ config: z.unknown(), filter: filterSchema })
    .parse(JSON.parse(query));
  return { config: parsed.config, filter: parsed.filter as GlobalFilter };
}
