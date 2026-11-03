import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { DashboardFilter } from "@/components/dashboard/dashboard-filter";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { DashboardSwitcher } from "@/components/dashboard/dashboard-switcher";
import { PageLoading } from "@/components/page-loading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { DASHBOARD_PARAM, parseDashboardFilter } from "@/lib/dashboard-filter";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { webActor } from "@/server/auth/request-actor";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { env } from "@/server/env";
import { ensureDashboards, getDashboard } from "@/server/services/dashboards";
import { getPreferences, isOnboarded } from "@/server/services/preferences";

export const metadata: Metadata = { title: `${TEXTS.overview.title} | ${TEXTS.appName}` };

async function OverviewContent({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const { user } = await requireSession();
  const params = await searchParams;
  const today = calendarDateInPrague(clock.now());
  const filter = parseDashboardFilter(params, today);
  // R-19: the one write of the overview, creating the default dashboard on the first visit.
  const dashboards = ensureDashboards(webActor(await headers(), user.id, env));
  const wanted = params[DASHBOARD_PARAM];
  const current =
    dashboards.find((item) => item.id === wanted) ??
    dashboards.find((item) => item.isDefault) ??
    dashboards[0]!;
  const dashboard = getDashboard(user.id, current.id)!;
  return (
    <>
      {!isOnboarded(user.id) && (
        <Alert>
          <AlertTitle>{TEXTS.overview.onboardingTitle}</AlertTitle>
          <AlertDescription>
            <p>{TEXTS.overview.onboardingBody}</p>
            <Link href="/pruvodce" className={buttonVariants({ size: "sm" })}>
              {TEXTS.overview.onboardingAction}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {dashboards.length > 1 && (
        <DashboardSwitcher dashboards={dashboards} currentId={dashboard.id} filter={filter} />
      )}
      <DashboardFilter filter={filter} dashboardId={current.isDefault ? null : current.id} />
      <DashboardGrid
        dashboard={dashboard}
        filter={filter}
        userId={user.id}
        today={today}
        dateFormat={getPreferences(user.id).dateFormat}
      />
    </>
  );
}

export default function OverviewPage({ searchParams }: PageProps<"/">) {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.overview.title}</h1>
      <Suspense fallback={<PageLoading />}>
        <OverviewContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
