import { CHART_TOKENS, type ChartSeries, type ChartSpec } from "@/components/charts/chart-spec";
import type { Currency } from "@/lib/currency";
import { bucketLabel, type ReportTab } from "@/lib/report-filter";
import { TEXTS } from "@/lib/texts";
import { FORECAST_SERIES } from "@/server/reports/forecast";
import { AGING_BANDS, type RankedRow, type Series } from "@/server/reports/types";
import type { ReportBundle } from "@/server/services/reports";
import { alignPrevious } from "@/server/reports/align";
import { rankedName } from "@/server/services/report-export";

const T = TEXTS.reports;
const token = (index: number) => CHART_TOKENS[index % CHART_TOKENS.length]!;

function comparedSeries(bundle: ReportBundle): ChartSeries[] {
  return [
    { key: "current", label: T.series.current, token: "chart-1" },
    {
      key: "previous",
      label: bundle.compare === "year" ? T.series.year : T.series.previous,
      token: "chart-2",
    },
  ];
}

// alignPrevious pairs the buckets from the end, as the export does.
function compared(
  bundle: ReportBundle,
  kind: ChartSpec["kind"],
  ariaLabel: string,
  current: Series,
  previous: Series,
  cumulative = false,
): ChartSpec {
  const aligned = alignPrevious(current, previous);
  let sums = { current: 0, previous: 0 };
  return {
    kind,
    ariaLabel,
    format: { kind: "money", currency: bundle.currency },
    series: comparedSeries(bundle),
    rows: current.points.map((point, index) => {
      const values = {
        current: point.amountMinor,
        previous: aligned[index]!,
      };
      if (cumulative) {
        sums = {
          current: sums.current + values.current,
          previous: sums.previous + values.previous,
        };
      }
      return {
        x: point.key,
        label: bucketLabel(point.key, bundle.unit),
        values: cumulative ? { ...sums } : values,
      };
    }),
  };
}

function shares(
  ariaLabel: string,
  corner: string,
  currency: Currency,
  slices: { key: string; label: string; amountMinor: number }[],
): ChartSpec {
  return {
    kind: "donut",
    ariaLabel,
    corner,
    format: { kind: "money", currency },
    series: slices.map((slice, index) => ({
      key: slice.key,
      label: slice.label,
      token: token(index),
    })),
    rows: [
      {
        x: "total",
        label: T.columns.total,
        values: Object.fromEntries(slices.map((slice) => [slice.key, slice.amountMinor])),
      },
    ],
  };
}

function rankedSlices(rows: RankedRow[]) {
  return rows
    .filter((row) => row.kind !== "adjustment" && row.amountMinor > 0)
    .map((row) => ({
      key: row.key || "none",
      label: rankedName(row, T.noCustomer),
      amountMinor: row.amountMinor,
    }));
}

export function reportCharts(tab: ReportTab, bundle: ReportBundle): ChartSpec[] {
  switch (tab) {
    case "fakturace":
      return [
        compared(bundle, "bar", T.charts.invoiced, bundle.invoiced, bundle.previousInvoiced),
        compared(
          bundle,
          "area",
          T.charts.invoicedCumulative,
          bundle.invoiced,
          bundle.previousInvoiced,
          true,
        ),
      ];
    case "uhrady":
      return [
        compared(bundle, "line", T.charts.income, bundle.income, bundle.previousIncome),
        compared(bundle, "heatmap", T.charts.incomeHeat, bundle.income, bundle.previousIncome),
      ];
    case "pohledavky":
      return [
        {
          kind: "bar",
          ariaLabel: T.charts.aging,
          corner: T.chart.corners.band,
          format: { kind: "money", currency: bundle.currency },
          series: [{ key: "amount", label: T.columns.amount, token: "chart-3" }],
          rows: AGING_BANDS.map((band) => ({
            x: band,
            label: T.aging[band],
            values: { amount: bundle.aging.bands[band] },
          })),
        },
      ];
    case "zakaznici":
      return [
        shares(
          T.charts.customers,
          T.chart.corners.customer,
          bundle.currency,
          rankedSlices(bundle.customers.rows),
        ),
      ];
    case "meny":
      return [
        shares(
          T.charts.currencies,
          T.chart.corners.currency,
          "CZK",
          bundle.currencies.rows
            .filter((row) => row.czkMinor > 0)
            .map((row) => ({ key: row.currency, label: row.currency, amountMinor: row.czkMinor })),
        ),
      ];
    case "predpoved":
      return [
        {
          kind: "stacked_bar",
          ariaLabel: T.charts.forecast,
          format: { kind: "money", currency: "CZK" },
          series: FORECAST_SERIES.map((series, index) => ({
            key: series,
            label: T.forecast[series],
            token: token(index),
          })),
          rows: bundle.forecast.map((month) => ({
            x: month.month,
            label: bucketLabel(month.month, "month"),
            values: Object.fromEntries(FORECAST_SERIES.map((series) => [series, month[series]])),
          })),
        },
      ];
    case "polozky":
    case "limity":
      return [];
  }
}
