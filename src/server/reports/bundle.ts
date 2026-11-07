import { and, notInArray, sql } from "drizzle-orm";
import type { Currency } from "@/lib/currency";
import type { CalendarDate } from "@/lib/number-format";
import type { TurnoverBasis } from "@/lib/preferences";
import { bucketUnitFor, type ReportQueryFilter } from "@/lib/report-filter";
import {
  comparisonRange,
  previousRange,
  type BucketUnit,
  type CompareMode,
} from "@/lib/report-period";
import { NOT_IN_TOTALS } from "../db/invoice-sql";
import { invoice, preferences } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "../services/access";
import { anchorFor, spanSeries, type AlignAnchor } from "./align";
import { forecast, type ForecastMonth } from "./forecast";
import * as core from "./queries";
import { limitStates, type LimitState } from "./turnover";
import type {
  Aging,
  CurrencyShares,
  DateRange,
  PaymentDays,
  Ranking,
  ReportSummary,
  Series,
} from "./types";

export const REPORT_TOP_ROWS = 20;

export type ReportBundle = {
  today: CalendarDate;
  range: DateRange;
  previousRange: DateRange;
  anchor: AlignAnchor;
  compare: CompareMode;
  unit: BucketUnit;
  currency: Currency;
  hasDocuments: boolean;
  summary: ReportSummary;
  previous: ReportSummary;
  invoiced: Series;
  income: Series;
  previousInvoiced: Series;
  previousIncome: Series;
  aging: Aging;
  customers: Ranking;
  items: Ranking;
  currencies: CurrencyShares;
  paymentDays: PaymentDays;
  limits: { year: number; basis: TurnoverBasis; states: LimitState[] };
  forecast: ForecastMonth[];
};

function hasDocuments(q: Reader, ownerId: string): boolean {
  return (
    q
      .select({ one: sql<number>`1` })
      .from(invoice)
      .where(and(scoped(ownerId).where(invoice), notInArray(invoice.status, NOT_IN_TOTALS)))
      .limit(1)
      .get() !== undefined
  );
}

// Everything the Statistics page and its exports show, from one read snapshot.
export function reportBundle(
  q: core.SnapshotReader,
  ownerId: string,
  { compare, ...filter }: ReportQueryFilter,
  today: CalendarDate,
): ReportBundle {
  return q.transaction(
    (tx: core.SnapshotReader & Reader) => {
      const unit = bucketUnitFor(filter.range);
      const span = previousRange(filter.range, compare);
      const before = { ...filter, range: comparisonRange(filter.range, compare, today) };
      const year = Number(today.slice(0, 4));
      const basis =
        tx
          .select({ basis: preferences.turnoverBasis })
          .from(preferences)
          .where(scoped(ownerId).where(preferences))
          .get()?.basis ?? "taxable";
      return {
        today,
        range: filter.range,
        previousRange: before.range,
        anchor: anchorFor(filter.range, today),
        compare,
        unit,
        currency: filter.currency ?? "CZK",
        hasDocuments: hasDocuments(tx, ownerId),
        summary: core.reportSummary(tx, ownerId, filter, today),
        previous: core.reportSummary(tx, ownerId, before, today),
        invoiced: core.invoicedSeries(tx, ownerId, filter, unit),
        income: core.incomeSeries(tx, ownerId, filter, unit),
        previousInvoiced: spanSeries(core.invoicedSeries(tx, ownerId, before, unit), span, unit),
        previousIncome: spanSeries(core.incomeSeries(tx, ownerId, before, unit), span, unit),
        aging: core.agingBands(tx, ownerId, filter, today),
        customers: core.topCustomers(tx, ownerId, filter, REPORT_TOP_ROWS),
        items: core.topItems(tx, ownerId, filter, REPORT_TOP_ROWS),
        currencies: core.currencyShares(tx, ownerId, filter),
        paymentDays: core.paymentDays(tx, ownerId, filter),
        limits: { year, basis, states: limitStates(tx, ownerId, year) },
        forecast: forecast(tx, ownerId, today),
      };
    },
    { behavior: "deferred" },
  );
}
