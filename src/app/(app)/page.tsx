import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DueAlerts } from "@/components/overview/due-alerts";
import { PageLoading } from "@/components/page-loading";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { dueAlerts } from "@/server/services/due-alerts";
import { getPreferences, isOnboarded } from "@/server/services/preferences";

export const metadata: Metadata = { title: `${TEXTS.overview.title} | ${TEXTS.appName}` };

async function OverviewContent() {
  const { user } = await requireSession();
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
      <DueAlerts
        {...dueAlerts(user.id, calendarDateInPrague(clock.now()))}
        dateFormat={getPreferences(user.id).dateFormat}
      />
      <EmptyState
        icon={LayoutDashboard}
        title={TEXTS.overview.emptyTitle}
        description={TEXTS.overview.emptyBody}
        action={
          <Link href="/nastaveni/ucet" className={buttonVariants()}>
            {TEXTS.overview.action}
          </Link>
        }
      />
    </>
  );
}

export default function OverviewPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.overview.title}</h1>
      <Suspense fallback={<PageLoading />}>
        <OverviewContent />
      </Suspense>
    </>
  );
}
