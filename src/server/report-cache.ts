import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { parseWidgetQuery } from "@/lib/dashboard-filter";
import { filterFromQuery, taxFromQuery } from "@/lib/report-filter";
import { accountTag } from "./account-cache";
import { taxPage, type TaxPage } from "./reports/tax";
import type { WidgetResult } from "./reports/widget-query";
import { reportBundle, type ReportBundle } from "./services/reports";
import { taxOverview } from "./services/tax-report";
import { checkedConfig, widgetResult } from "./services/widgets";

// The only module with "use cache" and next/cache: the report core stays free of Next (ARC-001).
// The stamp is in the key only, so any write to the account, even from the scheduler, misses the
// cache (R-14). Callers pass the session's user id, never one taken from the request.
export async function cachedReport(
  userId: string,
  stamp: string,
  today: string,
  query: string,
): Promise<ReportBundle> {
  "use cache";
  cacheLife("hours");
  cacheTag(accountTag(userId));
  void stamp;
  return reportBundle(userId, filterFromQuery(query), today);
}

export async function cachedWidget(
  userId: string,
  stamp: string,
  today: string,
  query: string,
): Promise<WidgetResult> {
  "use cache";
  cacheLife("hours");
  cacheTag(accountTag(userId));
  void stamp;
  const { config, filter } = parseWidgetQuery(query);
  return widgetResult(userId, checkedConfig(config), { today, globalFilter: filter });
}

export async function cachedTax(
  userId: string,
  stamp: string,
  today: string,
  query: string,
): Promise<TaxPage> {
  "use cache";
  cacheLife("hours");
  cacheTag(accountTag(userId));
  void stamp;
  return taxPage(taxOverview(userId, taxFromQuery(query), today));
}
