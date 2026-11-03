import "server-only";
import type { Currency } from "@/lib/currency";
import type { CalendarDate } from "@/lib/number-format";
import { bucketLabel, type ParsedReportFilter, type ReportTab } from "@/lib/report-filter";
import { count, money, text, toCsv, type Cell, type Sheet } from "@/lib/tabular";
import { TEXTS } from "@/lib/texts";
import { toXlsx } from "@/lib/xlsx-writer";
import type { Actor } from "../audit/context";
import { FORECAST_SERIES } from "../reports/forecast";
import { alignPrevious } from "../reports/align";
import { AGING_BANDS, type RankedRow, type Series, type Unconverted } from "../reports/types";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { mutate } from "./mutation";
import { reportBundle, type ReportBundle } from "./reports";

const T = TEXTS.reports;
const C = T.columns;

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// A record without a CZK value is listed in its own currency instead of vanishing (R-9).
function unconvertedRows(unconverted: Unconverted, width: number): Cell[][] {
  if (unconverted.count === 0) return [];
  const pad = Array<Cell>(Math.max(0, width - 2)).fill(null);
  return unconverted.byCurrency.map(({ currency, amountMinor }) => [
    text(`${T.unconverted(unconverted.count)} (${currency})`),
    money(amountMinor, currency),
    ...pad,
  ]);
}

function merged(list: Unconverted[]): Unconverted {
  const byCurrency = new Map<Currency, number>();
  let total = 0;
  for (const item of list) {
    total += item.count;
    for (const { currency, amountMinor } of item.byCurrency) {
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amountMinor);
    }
  }
  return {
    count: total,
    byCurrency: [...byCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amountMinor]) => ({ currency, amountMinor })),
  };
}

// Everything the forecast could not convert, over all months and series (R-9, R-17).
export function forecastUnconverted(months: ReportBundle["forecast"]): Unconverted {
  return merged(
    months.flatMap((month) => FORECAST_SERIES.map((series) => month.unconverted[series])),
  );
}

function previousLabel(bundle: ReportBundle): string {
  return bundle.compare === "year" ? T.series.year : T.series.previous;
}

function seriesSheet(
  bundle: ReportBundle,
  name: string,
  heading: string,
  current: Series,
  previous: Series,
  totals: [number, number],
): Sheet {
  const currency = bundle.currency;
  const aligned = alignPrevious(current, previous);
  return {
    name,
    columns: [C.period, heading, previousLabel(bundle)],
    rows: [
      ...current.points.map((point, index) => [
        text(bucketLabel(point.key, bundle.unit)),
        money(point.amountMinor, currency),
        money(aligned[index]!, currency),
      ]),
      [text(C.total), money(totals[0], currency), money(totals[1], currency)],
      ...unconvertedRows(current.unconverted, 3),
    ],
  };
}

export function rankedName(row: RankedRow, fallback: string): string {
  if (row.kind === "others") return T.others;
  if (row.kind === "adjustment") return T.adjustment;
  return row.name || fallback;
}

function rankingRows(rows: RankedRow[], currency: Currency, fallback: string): Cell[][] {
  const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);
  return [
    ...rows.map((row) => [text(rankedName(row, fallback)), money(row.amountMinor, currency)]),
    [text(C.total), money(total, currency)],
  ];
}

export function buildSheet(report: ReportTab, bundle: ReportBundle): Sheet {
  const name = T.tabs[report];
  const currency = bundle.currency;
  switch (report) {
    case "fakturace":
      return seriesSheet(bundle, name, C.invoiced, bundle.invoiced, bundle.previousInvoiced, [
        bundle.summary.invoicedMinor,
        bundle.previous.invoicedMinor,
      ]);
    case "uhrady":
      return seriesSheet(bundle, name, C.income, bundle.income, bundle.previousIncome, [
        bundle.summary.incomeMinor,
        bundle.previous.incomeMinor,
      ]);
    case "pohledavky": {
      const { bands } = bundle.aging;
      const total = AGING_BANDS.reduce((sum, band) => sum + bands[band], 0);
      return {
        name,
        columns: [C.band, C.amount],
        rows: [
          ...AGING_BANDS.map((band) => [text(T.aging[band]), money(bands[band], currency)]),
          [text(T.aging.total), money(total, currency)],
          [text(T.aging.advances), money(bundle.summary.advanceOpenMinor, currency)],
          ...unconvertedRows(bundle.aging.unconverted, 2),
        ],
      };
    }
    case "zakaznici":
      return {
        name,
        columns: [C.customer, C.invoiced],
        rows: [
          ...rankingRows(bundle.customers.rows, currency, T.noCustomer),
          ...unconvertedRows(bundle.customers.unconverted, 2),
        ],
      };
    case "polozky":
      return {
        name,
        columns: [C.item, C.invoiced],
        rows: [
          ...rankingRows(bundle.items.rows, currency, T.noName),
          ...unconvertedRows(bundle.items.unconverted, 2),
        ],
      };
    case "meny":
      return {
        name,
        columns: [C.currency, C.inCurrency, C.inCzk],
        rows: [
          ...bundle.currencies.rows.map((row) => [
            text(row.currency),
            money(row.amountMinor, row.currency),
            money(row.czkMinor, "CZK"),
          ]),
          [
            text(C.total),
            null,
            money(
              bundle.currencies.rows.reduce((sum, row) => sum + row.czkMinor, 0),
              "CZK",
            ),
          ],
          ...unconvertedRows(bundle.currencies.unconverted, 3),
        ],
      };
    case "limity": {
      const unconverted = bundle.limits.states[0]?.unconverted;
      return {
        name,
        columns: [C.limit, C.threshold, C.turnover, C.used, C.level],
        rows: [
          ...bundle.limits.states.map((state) => [
            text(T.limits[state.key]),
            money(state.limitMinor, "CZK"),
            money(state.turnoverMinor, "CZK"),
            state.watched ? count(state.percent) : null,
            text(state.watched ? T.limits.levels[state.level] : T.limits.unwatched),
          ]),
          [
            text(T.limits.basis),
            text(TEXTS.preferences.turnoverBases[bundle.limits.basis]),
            null,
            null,
            null,
          ],
          ...(unconverted ? unconvertedRows(unconverted, 5) : []),
        ],
      };
    }
    case "predpoved": {
      const columns = [C.month, ...FORECAST_SERIES.map((series) => T.forecast[series]), C.total];
      return {
        name,
        columns,
        rows: [
          ...bundle.forecast.map((month) => [
            text(bucketLabel(month.month, "month")),
            ...FORECAST_SERIES.map((series) => money(month[series], "CZK")),
            money(
              FORECAST_SERIES.reduce((sum, series) => sum + month[series], 0),
              "CZK",
            ),
          ]),
          ...unconvertedRows(forecastUnconverted(bundle.forecast), columns.length),
        ],
      };
    }
  }
}

export type ReportFile = { filename: string; contentType: string; body: string | Uint8Array };

// The file name is built from the validated tab and dates only, never from free text.
export function exportReport(
  actor: Actor,
  { tab, ...filter }: ParsedReportFilter,
  format: ExportFormat,
  today: CalendarDate,
): ReportFile {
  const ownerId = actor.userId;
  if (!ownerId) throw new ServiceError(T.errors.signedOut);
  enforceRateLimit(actor, RATE_RULES.exportUser);
  const sheet = buildSheet(tab, reportBundle(ownerId, filter, today));
  mutate(actor, "report.export", (_tx, audit) =>
    audit({
      entity: "report",
      entityId: tab,
      ownerId,
      scope: "user",
      after: {
        format,
        from: filter.range.from,
        to: filter.range.to,
        currency: filter.currency ?? null,
        includeExternal: filter.includeExternal,
      },
    }),
  );
  const filename = `statistiky-${tab}-${filter.range.from}-${filter.range.to}.${format}`;
  return format === "csv"
    ? { filename, contentType: "text/csv; charset=utf-8", body: toCsv(sheet) }
    : {
        filename,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: toXlsx(sheet),
      };
}
