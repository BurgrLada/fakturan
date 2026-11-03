export const CHART_TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

export function isChartToken(value: unknown): value is ChartToken {
  return typeof value === "string" && (CHART_TOKENS as readonly string[]).includes(value);
}
