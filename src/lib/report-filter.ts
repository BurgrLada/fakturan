import { z } from "zod";
import type { ReportFilter } from "@/server/reports/types";
import { CURRENCIES, type Currency } from "./currency";
import { isCalendarDate, type CalendarDate } from "./number-format";
import { TEXTS } from "./texts";
import {
  PERIOD_TOKENS,
  resolvePeriod,
  type BucketUnit,
  type CompareMode,
  type DateRange,
  type PeriodToken,
} from "./report-period";

export const REPORT_TABS = [
  "fakturace",
  "uhrady",
  "pohledavky",
  "zakaznici",
  "polozky",
  "meny",
  "limity",
  "predpoved",
] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export const PERIOD_PARAM: Record<PeriodToken, string> = {
  this_month: "mesic",
  this_quarter: "ctvrtleti",
  this_year: "rok",
  last_year: "minuly-rok",
  last_30_days: "30-dni",
  last_12_months: "12-mesicu",
};
export const CUSTOM_PERIOD = "vlastni";

export const COMPARE_MODES = ["previous", "year"] as const satisfies CompareMode[];
export const COMPARE_PARAM: Record<CompareMode, string> = { previous: "predchozi", year: "rok" };

const DEFAULT_PERIOD: PeriodToken = "this_year";
const MAX_RANGE_YEARS = 10;
const EXCLUDE_EXTERNAL = "ne";

export type ParsedReportFilter = ReportFilter & { tab: ReportTab; compare: CompareMode };
export type ReportQueryFilter = Omit<ParsedReportFilter, "tab">;

type RawParams = Record<string, string | string[] | undefined>;

const keyOf = <K extends string>(map: Record<K, string>, value: string | undefined) =>
  (Object.keys(map) as K[]).find((key) => map[key] === value);

// R-24: a longer range would block the synchronous database for every other request.
function withinLimit({ from, to }: DateRange): boolean {
  const [year, month, day] = from.split("-");
  return `${Number(year) + MAX_RANGE_YEARS}-${month}-${day}` > to;
}

function customRange(from: string | undefined, to: string | undefined): DateRange | undefined {
  if (!from || !to || !isCalendarDate(from) || !isCalendarDate(to) || from > to) return undefined;
  const range = { from, to };
  return withinLimit(range) ? range : undefined;
}

// Query strings are untrusted: anything that does not fit is dropped and the default applies.
export function parseReportFilter(params: RawParams, today: CalendarDate): ParsedReportFilter {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const token = keyOf(PERIOD_PARAM, one("obdobi"));
  const custom = token ? undefined : customRange(one("od"), one("do"));
  const currency = CURRENCIES.find((code) => code === one("mena"));
  return {
    tab: REPORT_TABS.find((tab) => tab === one("zalozka")) ?? "fakturace",
    range: custom ?? resolvePeriod(token ?? DEFAULT_PERIOD, today),
    compare: keyOf(COMPARE_PARAM, one("porovnani")) ?? "previous",
    ...(currency && { currency }),
    includeExternal: one("importovane") !== EXCLUDE_EXTERNAL,
  };
}

export function reportPeriodToken(range: DateRange, today: CalendarDate): PeriodToken | null {
  return (
    PERIOD_TOKENS.find((token) => {
      const resolved = resolvePeriod(token, today);
      return resolved.from === range.from && resolved.to === range.to;
    }) ?? null
  );
}

// Relative periods stay relative in links, so a bookmark keeps meaning "this year".
export function reportParams(
  filter: ParsedReportFilter,
  today: CalendarDate,
): Record<string, string> {
  const token = reportPeriodToken(filter.range, today);
  return {
    zalozka: filter.tab,
    ...(token
      ? { obdobi: PERIOD_PARAM[token] }
      : { obdobi: CUSTOM_PERIOD, od: filter.range.from, do: filter.range.to }),
    porovnani: COMPARE_PARAM[filter.compare],
    ...(filter.currency && { mena: filter.currency }),
    ...(!filter.includeExternal && { importovane: EXCLUDE_EXTERNAL }),
  };
}

export function reportHref(filter: ParsedReportFilter, today: CalendarDate): string {
  return `/prehledy?${new URLSearchParams(reportParams(filter, today))}`;
}

const querySchema = z
  .object({
    from: z.string().refine(isCalendarDate),
    to: z.string().refine(isCalendarDate),
    currency: z.enum(CURRENCIES).nullable(),
    includeExternal: z.boolean(),
    compare: z.enum(COMPARE_MODES),
  })
  .strict();

// The cache key: the tab is left out, so switching tabs reuses the same computed bundle.
export function reportQuery(filter: ReportQueryFilter): string {
  return JSON.stringify({
    from: filter.range.from,
    to: filter.range.to,
    currency: filter.currency ?? null,
    includeExternal: filter.includeExternal,
    compare: filter.compare,
  });
}

export function filterFromQuery(query: string): ReportQueryFilter {
  const parsed = querySchema.parse(JSON.parse(query));
  const range = { from: parsed.from, to: parsed.to };
  if (range.from > range.to || !withinLimit(range))
    throw new RangeError(TEXTS.reports.errors.invalidPeriod);
  const currency: Currency | undefined = parsed.currency ?? undefined;
  return {
    range,
    ...(currency && { currency }),
    includeExternal: parsed.includeExternal,
    compare: parsed.compare,
  };
}

// R-24 allows at most 400 buckets; ten years by quarter is 40.
export function bucketUnitFor({ from, to }: DateRange): BucketUnit {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days <= 62) return "day";
  if (days <= 1096) return "month";
  return "quarter";
}

const MONTH = new Intl.DateTimeFormat("cs-CZ", { month: "long", year: "numeric", timeZone: "UTC" });

export function bucketLabel(key: string, unit: BucketUnit): string {
  switch (unit) {
    case "day": {
      const [year, month, day] = key.split("-").map(Number);
      return `${day}. ${month}. ${year}`;
    }
    case "week": {
      const [year, week] = key.split("-W");
      return TEXTS.reports.week(Number(week), year!);
    }
    case "month": {
      const [year, month] = key.split("-").map(Number) as [number, number];
      return MONTH.format(new Date(Date.UTC(year, month - 1, 1)));
    }
    case "quarter": {
      const [year, quarter] = key.split("-Q");
      return TEXTS.reports.quarter(quarter!, year!);
    }
    case "year":
      return key;
  }
}
