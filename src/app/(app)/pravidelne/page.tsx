import { Repeat } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageLoading } from "@/components/page-loading";
import { RecurringList } from "@/components/recurring/recurring-list";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listRecurring } from "@/server/services/recurring";

const T = TEXTS.recurring;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function RecurringContent() {
  const { user } = await requireSession();
  const rows = listRecurring(user.id);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Repeat}
        title={T.empty}
        description={T.emptyBody}
        action={
          <Link href="/pravidelne/nova" className={buttonVariants({ variant: "outline" })}>
            {T.newPlan}
          </Link>
        }
      />
    );
  }
  return (
    <RecurringList
      rows={rows.map(({ id, name, customerId, customerName, nextIssueDate, mode, status }) => ({
        id,
        name,
        customerId,
        customerName,
        nextIssueDate,
        mode,
        status,
      }))}
    />
  );
}

export default function RecurringPage() {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-2xl">{T.title}</h1>
        <Link href="/pravidelne/nova" className={buttonVariants()}>
          {T.newPlan}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <RecurringContent />
      </Suspense>
    </>
  );
}
