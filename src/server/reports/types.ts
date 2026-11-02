import type { Currency } from "@/lib/currency";
import type { BucketUnit, DateRange } from "@/lib/report-period";

export type { BucketUnit, DateRange };

export type ReportFilter = {
  range: DateRange;
  currency?: Currency;
  includeExternal: boolean;
  customerIds?: string[];
};

// Records left out of a sum because they have no CZK value yet (R-9), in their own currency.
export type Unconverted = {
  count: number;
  byCurrency: { currency: Currency; amountMinor: number }[];
};

export const SUMMARY_METRICS = [
  "invoiced",
  "income",
  "outstanding",
  "overdue",
  "advanceOpen",
] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number];

// Flows (invoiced, income) follow the period; the balances are the state as of today. Each number
// lists what it is missing: totals for invoiced, payments for income, balances for the rest.
export type ReportSummary = {
  invoicedMinor: number;
  incomeMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  advanceOpenMinor: number;
  unconverted: Record<SummaryMetric, Unconverted>;
};

export type SeriesPoint = { key: string; amountMinor: number };
export type Series = { points: SeriesPoint[]; unconverted: Unconverted };

export const AGING_BANDS = [
  "current",
  "days0to30",
  "days31to60",
  "days61to90",
  "days90plus",
] as const;
export type AgingBand = (typeof AGING_BANDS)[number];
export type Aging = { bands: Record<AgingBand, number>; unconverted: Unconverted };

// "others" sums what did not fit into the top rows, "adjustment" is the document discount and
// rounding that lines do not carry (R-10), so every table adds up to the invoiced amount.
export type RankedRow = {
  kind: "row" | "others" | "adjustment";
  key: string;
  name: string;
  amountMinor: number;
};
export type Ranking = { rows: RankedRow[]; unconverted: Unconverted };

export type CurrencyShare = { currency: Currency; amountMinor: number; czkMinor: number };
export type CurrencyShares = { rows: CurrencyShare[]; unconverted: Unconverted };

export type PaymentDays = { averageDays: number | null; count: number };

export const MAX_TOP_ROWS = 50;
