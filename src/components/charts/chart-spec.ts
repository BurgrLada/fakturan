import type { Currency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";

import type { ChartToken } from "@/lib/chart-tokens";

export { CHART_TOKENS, isChartToken, type ChartToken } from "@/lib/chart-tokens";

export type ChartKind = "bar" | "stacked_bar" | "line" | "area" | "donut" | "heatmap";

export type ValueFormat = { kind: "money"; currency: Currency } | { kind: "number" };

export type ChartSeries = { key: string; label: string; token: ChartToken };
export type ChartRow = { x: string; label: string; values: Record<string, number> };

// Plain data only: it crosses the server/client boundary. Values are integers (minor units for money).
export type ChartSpec = {
  kind: ChartKind;
  series: ChartSeries[];
  rows: ChartRow[];
  format: ValueFormat;
  ariaLabel: string;
  ariaDescription?: string;
  // Values written on the marks (DSH-016); ignored where marks overlap, as in grouped bars.
  labels?: boolean;
};

const NUMBER = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });

export function formatChartValue(format: ValueFormat, value: number): string {
  const whole = Math.round(value);
  return format.kind === "money" ? formatMoney(whole, format.currency) : NUMBER.format(whole);
}

export function chartColor(token: ChartToken): string {
  return `var(--${token})`;
}

export type ChartDatum = { x: string; label: string; series: string; value: number };

// A missing value is drawn as zero so a gap never reads as a different total.
export function chartData(spec: ChartSpec): ChartDatum[] {
  return spec.rows.flatMap((row) =>
    spec.series.map((series) => ({
      x: row.x,
      label: row.label,
      series: series.label,
      value: row.values[series.key] ?? 0,
    })),
  );
}

export type ChartTableModel = {
  corner: string;
  head: string[];
  rows: { label: string; cells: string[] }[];
};

export function chartTableModel(spec: ChartSpec): ChartTableModel {
  return {
    corner: TEXTS.reports.chart.category,
    head: spec.series.map((series) => series.label),
    rows: spec.rows.map((row) => ({
      label: row.label,
      cells: spec.series.map((series) =>
        formatChartValue(spec.format, row.values[series.key] ?? 0),
      ),
    })),
  };
}
