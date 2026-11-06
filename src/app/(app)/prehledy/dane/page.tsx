import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReportTabs } from "@/components/reports/report-tabs";
import { TaxOverviewView } from "@/components/reports/tax-overview";
import { calendarDateInPrague } from "@/lib/number-format";
import { parseReportFilter, parseTaxFilter, taxQuery } from "@/lib/report-filter";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { cachedTax } from "@/server/report-cache";
import { accountStamp } from "@/server/services/reports";

const T = TEXTS.tax;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function TaxContent({ searchParams }: Pick<PageProps<"/prehledy/dane">, "searchParams">) {
  const { user } = await requireSession();
  const today = calendarDateInPrague(clock.now());
  const filter = parseTaxFilter(await searchParams, today);
  const overview = await cachedTax(user.id, accountStamp(user.id), today, taxQuery(filter));
  return (
    <>
      <ReportTabs filter={parseReportFilter({}, today)} today={today} taxActive />
      <TaxOverviewView overview={overview} filter={filter} today={today} />
    </>
  );
}

export default function TaxPage({ searchParams }: PageProps<"/prehledy/dane">) {
  return (
    <>
      <div className="space-y-1">
        <h1 className="font-brand text-2xl">{T.title}</h1>
        <p className="text-sm text-muted-foreground">{T.intro}</p>
      </div>
      <Suspense fallback={<PageLoading />}>
        <TaxContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
