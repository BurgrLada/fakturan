import "server-only";
import { sql } from "drizzle-orm";
import type { CalendarDate } from "@/lib/number-format";
import type { ReportQueryFilter } from "@/lib/report-filter";
import type { BucketUnit } from "@/lib/report-period";
import { db } from "../db";
import { auditLog, exchangeRate } from "../db/schema";
import { scoped } from "../db/scoped";
import * as core from "../reports/queries";
import { reportBundle as bundleOf, type ReportBundle } from "../reports/bundle";
import type { ReportFilter } from "../reports/types";

export function reportSummary(ownerId: string, filter: ReportFilter, today: CalendarDate) {
  return core.reportSummary(db, ownerId, filter, today);
}

export function reportCounts(ownerId: string, filter: ReportFilter, today: CalendarDate) {
  return core.summaryCounts(db, ownerId, filter, today);
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

// R-14: read outside the cache and passed into its key. Every mutation writes an audit row in the
// same transaction (web or scheduler alike) and ids only grow; a new CNB list changes rates of all
// accounts. Neither needs a request, so data written by the scheduler is never served stale.
export function accountStamp(ownerId: string): string {
  const audit = db
    .select({ id: sql<number | null>`max(${auditLog.id})` })
    .from(auditLog)
    .where(scoped(ownerId).where(auditLog))
    .get();
  const rates = db
    .select({ at: sql<number | null>`max(${exchangeRate.fetchedAt})` })
    .from(exchangeRate)
    .get();
  return `${audit?.id ?? 0}:${rates?.at ?? 0}`;
}

export type { ReportBundle };

export function reportBundle(
  ownerId: string,
  filter: ReportQueryFilter,
  today: CalendarDate,
): ReportBundle {
  return bundleOf(db, ownerId, filter, today);
}
