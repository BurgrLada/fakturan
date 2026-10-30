import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Button, buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { EDITABLE_STATUSES } from "@/server/services/invoice-versions";
import { getInvoice } from "@/server/services/invoices";

const T = TEXTS.invoices.detail;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function DetailContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  if (!row) notFound();
  if (row.status === "draft") redirect(`/faktury/${id}/upravit`);

  return (
    <>
      <h1 className="font-brand text-2xl">
        {T.title} {row.number}
      </h1>
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/faktury/${id}/pdf`} className={buttonVariants({ variant: "outline" })}>
          {T.download}
        </a>
        {EDITABLE_STATUSES.has(row.status) && (
          <Link href={`/faktury/${id}/upravit`} className={buttonVariants({ variant: "outline" })}>
            {T.edit}
          </Link>
        )}
        <Button disabled aria-describedby="send-later">
          {T.send}
        </Button>
      </div>
      <p id="send-later" className="text-sm text-muted-foreground">
        {T.sendLater}
      </p>
    </>
  );
}

export default function InvoiceDetailPage({ params }: PageProps<"/faktury/[id]">) {
  return (
    <>
      <Link
        href="/faktury"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {T.back}
      </Link>
      <Suspense fallback={<PageLoading />}>
        <DetailContent params={params} />
      </Suspense>
    </>
  );
}
