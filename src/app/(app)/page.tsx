import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";

export const metadata: Metadata = { title: `${TEXTS.overview.title} | ${TEXTS.appName}` };

async function OverviewContent() {
  await requireSession();
  return (
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
