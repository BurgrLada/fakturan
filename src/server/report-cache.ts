import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { filterFromQuery } from "@/lib/report-filter";
import { accountTag } from "./account-cache";
import { reportBundle, type ReportBundle } from "./services/reports";

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
