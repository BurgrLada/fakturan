import { PieChart } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Chart } from "@/components/charts/chart";
import { EmptyState } from "@/components/empty-state";
import { PageLoading } from "@/components/page-loading";
import { LimitsCard } from "@/components/reports/limits-card";
import { reportCharts } from "@/components/reports/report-charts";
import { ReportFilter } from "@/components/reports/report-filter";
import { ReportTable } from "@/components/reports/report-table";
import { ReportTabs } from "@/components/reports/report-tabs";
import { UnconvertedNote } from "@/components/reports/unconverted-note";
import { buttonVariants } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague } from "@/lib/number-format";
import {
  parseReportFilter,
  reportParams,
  reportQuery,
  type ParsedReportFilter,
} from "@/lib/report-filter";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { cachedReport } from "@/server/report-cache";
import type { SummaryMetric } from "@/server/reports/types";
import { buildSheet, forecastUnconverted } from "@/server/services/report-export";
import { accountStamp, type ReportBundle } from "@/server/services/reports";

const T = TEXTS.reports;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

const FLOWS = ["invoiced", "income"] as const;
const BALANCES = ["outstanding", "overdue", "advanceOpen"] as const;
const AMOUNT: Record<
  SummaryMetric,
  "invoicedMinor" | "incomeMinor" | "outstandingMinor" | "overdueMinor" | "advanceOpenMinor"
> = {
  invoiced: "invoicedMinor",
  income: "incomeMinor",
  outstanding: "outstandingMinor",
  overdue: "overdueMinor",
  advanceOpen: "advanceOpenMinor",
};

function signed(minor: number, currency: ReportBundle["currency"]): string {
  return `${minor > 0 ? "+" : ""}${formatMoney(minor, currency)}`;
}

function Summary({ bundle }: { bundle: ReportBundle }) {
  const { currency, summary, previous } = bundle;
  return (
    <section aria-label={T.summary.label} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {FLOWS.map((metric) => {
        const now = summary[AMOUNT[metric]];
        const before = previous[AMOUNT[metric]];
        return (
          <div
            key={metric}
            data-testid={`summary-${metric}`}
            className="space-y-1 rounded-md border p-3"
          >
            <p className="text-sm text-muted-foreground">{T.summary[metric]}</p>
            <p className="text-xl font-medium tabular-nums">{formatMoney(now, currency)}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs tabular-nums">
              <dt className="text-muted-foreground">{T.summary.previous}</dt>
              <dd data-testid={`previous-${metric}`}>{formatMoney(before, currency)}</dd>
              <dt className="text-muted-foreground">{T.summary.change}</dt>
              <dd data-testid={`change-${metric}`}>{signed(now - before, currency)}</dd>
            </dl>
            <UnconvertedNote unconverted={summary.unconverted[metric]} />
            <UnconvertedNote
              unconverted={previous.unconverted[metric]}
              prefix={T.summary.previous}
              testId="previous-unconverted"
            />
          </div>
        );
      })}
      {BALANCES.map((metric) => (
        <div
          key={metric}
          data-testid={`summary-${metric}`}
          className="space-y-1 rounded-md border p-3"
        >
          <p className="text-sm text-muted-foreground">{T.summary[metric]}</p>
          <p className="text-xl font-medium tabular-nums">
            {formatMoney(summary[AMOUNT[metric]], currency)}
          </p>
          <p className="text-xs text-muted-foreground">{T.summary.asOfToday}</p>
          <UnconvertedNote unconverted={summary.unconverted[metric]} />
        </div>
      ))}
      {bundle.paymentDays.averageDays !== null && (
        <div data-testid="summary-payment-days" className="space-y-1 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">{T.summary.paymentDays}</p>
          <p className="text-xl font-medium tabular-nums">
            {T.summary.days(bundle.paymentDays.averageDays)}
          </p>
        </div>
      )}
    </section>
  );
}

function ExportForm({ filter, today }: { filter: ParsedReportFilter; today: string }) {
  return (
    <form
      method="post"
      action="/prehledy/export"
      aria-label={T.exportLabel}
      className="flex flex-wrap gap-2"
    >
      {Object.entries(reportParams(filter, today)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        name="format"
        value="csv"
        className={buttonVariants({ variant: "outline" })}
      >
        {T.exportCsv}
      </button>
      <button
        type="submit"
        name="format"
        value="xlsx"
        className={buttonVariants({ variant: "outline" })}
      >
        {T.exportXlsx}
      </button>
    </form>
  );
}

function TabPanel({ filter, bundle }: { filter: ParsedReportFilter; bundle: ReportBundle }) {
  const tab = filter.tab;
  return (
    <section aria-labelledby="report-panel" className="min-w-0 space-y-4">
      <h2 id="report-panel" className="text-lg">
        {T.tabs[tab]}
      </h2>
      {(tab === "limity" || tab === "predpoved") && (
        <p data-testid="fixed-scope" className="text-sm text-muted-foreground">
          {T.fixedScope}
        </p>
      )}
      {tab === "limity" && <LimitsCard limits={bundle.limits} />}
      {tab === "predpoved" && (
        <>
          <p className="text-sm text-muted-foreground">{T.forecast.note}</p>
          <UnconvertedNote unconverted={forecastUnconverted(bundle.forecast)} />
        </>
      )}
      {reportCharts(tab, bundle).map((spec) => (
        <figure key={spec.ariaLabel} className="min-w-0 space-y-1">
          <figcaption className="text-sm font-medium">{spec.ariaLabel}</figcaption>
          <Chart spec={spec} />
        </figure>
      ))}
      <ReportTable sheet={buildSheet(tab, bundle)} />
      {tab === "pohledavky" && (
        <Link
          href={`/faktury?stav=po-splatnosti${filter.currency ? `&mena=${filter.currency}` : ""}`}
          className="text-sm underline underline-offset-4"
        >
          {T.aging.link}
        </Link>
      )}
    </section>
  );
}

async function ReportsContent({ searchParams }: Pick<PageProps<"/prehledy">, "searchParams">) {
  const { user } = await requireSession();
  const today = calendarDateInPrague(clock.now());
  const filter = parseReportFilter(await searchParams, today);
  const bundle = await cachedReport(user.id, accountStamp(user.id), today, reportQuery(filter));
  if (!bundle.hasDocuments) {
    return (
      <EmptyState
        icon={PieChart}
        title={T.empty}
        description={T.emptyBody}
        action={
          <a href="/faktury/nova" className={buttonVariants({ variant: "outline" })}>
            {T.emptyAction}
          </a>
        }
      />
    );
  }
  return (
    <>
      <ReportFilter filter={filter} today={today} />
      <Summary bundle={bundle} />
      <ReportTabs filter={filter} today={today} />
      <TabPanel filter={filter} bundle={bundle} />
      <ExportForm filter={filter} today={today} />
    </>
  );
}

export default function ReportsPage({ searchParams }: PageProps<"/prehledy">) {
  return (
    <>
      <div className="space-y-1">
        <h1 className="font-brand text-2xl">{T.title}</h1>
        <p className="text-sm text-muted-foreground">{T.intro}</p>
      </div>
      <Suspense fallback={<PageLoading />}>
        <ReportsContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
