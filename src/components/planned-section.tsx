import { Hammer } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { NAV_ITEMS, SHOW_PLANNED_SECTIONS, type NavKey } from "@/components/nav";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";

async function PlannedContent() {
  await requireSession();
  return (
    <EmptyState
      icon={Hammer}
      title={TEXTS.planned.badge}
      description={TEXTS.planned.body}
      action={
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          {TEXTS.planned.action}
        </Link>
      }
    />
  );
}

export function plannedMetadata(key: NavKey) {
  return { title: `${TEXTS.nav[key]} | ${TEXTS.appName}` };
}

export function PlannedSection({ navKey }: { navKey: NavKey }) {
  const section = NAV_ITEMS.find((entry) => entry.key === navKey && entry.planned);
  if (!section || !SHOW_PLANNED_SECTIONS) notFound();
  return (
    <>
      <h1 className="font-brand text-2xl">{section.label}</h1>
      <Suspense fallback={<PageLoading />}>
        <PlannedContent />
      </Suspense>
    </>
  );
}
