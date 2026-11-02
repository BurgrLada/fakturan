import "server-only";
import type { CalendarDate } from "@/lib/number-format";
import type { BucketUnit } from "@/lib/report-period";
import { db } from "../db";
import * as core from "../reports/queries";
import type { ReportFilter } from "../reports/types";

export function reportSummary(ownerId: string, filter: ReportFilter, today: CalendarDate) {
  return core.reportSummary(db, ownerId, filter, today);
}

export function invoicedSeries(ownerId: string, filter: ReportFilter, unit: BucketUnit) {
  return core.invoicedSeries(db, ownerId, filter, unit);
}

export function incomeSeries(ownerId: string, filter: ReportFilter, unit: BucketUnit) {
  return core.incomeSeries(db, ownerId, filter, unit);
}

export function agingBands(ownerId: string, filter: ReportFilter, today: CalendarDate) {
  return core.agingBands(db, ownerId, filter, today);
}

export function topCustomers(ownerId: string, filter: ReportFilter, limit?: number) {
  return core.topCustomers(db, ownerId, filter, limit);
}

export function topItems(ownerId: string, filter: ReportFilter, limit?: number) {
  return core.topItems(db, ownerId, filter, limit);
}

export function currencyShares(ownerId: string, filter: ReportFilter) {
  return core.currencyShares(db, ownerId, filter);
}

export function paymentDays(ownerId: string, filter: ReportFilter) {
  return core.paymentDays(db, ownerId, filter);
}
