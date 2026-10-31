import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { EntityHistory } from "@/components/audit/entity-history";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status";
import { VersionList } from "@/components/invoices/version-list";
import { PageLoading } from "@/components/page-loading";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { isOverdue } from "@/lib/invoice";
import { invoiceDocument } from "@/lib/invoice-document";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague } from "@/lib/number-format";
import { qrStateOf } from "@/lib/qr-payload";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { EDITABLE_STATUSES, listVersions } from "@/server/services/invoice-versions";
import { getInvoice, type InvoiceDetail } from "@/server/services/invoices";

const T = TEXTS.invoices.detail;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

function StatusSteps({ row }: { row: InvoiceDetail }) {
  const steps = [
    { label: T.steps.issued, value: formatDateTime(row.issuedAt) },
    { label: T.steps.sent, value: formatDateTime(row.sentAt) },
    { label: T.steps.paid, value: formatMoney(row.paidMinor, row.currency) },
    { label: T.steps.left, value: formatMoney(row.totalMinor - row.paidMinor, row.currency) },
  ];
  return (
    <dl
      data-testid="invoice-steps"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:max-w-md"
    >
      {steps.map((step) => (
        <div key={step.label} className="contents">
          <dt className="text-muted-foreground">{step.label}</dt>
          <dd>{step.value}</dd>
        </div>
      ))}
    </dl>
  );
}

async function DetailContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const row = getInvoice(user.id, id);
  if (!row) notFound();
  if (row.status === "draft") redirect(`/faktury/${id}/upravit`);

  const today = calendarDateInPrague(clock.now());
  const editable = EDITABLE_STATUSES.has(row.status);
  const qr = qrStateOf(invoiceDocument(row));
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-brand text-2xl">
          {T.title} {row.number}
        </h1>
        <InvoiceStatusBadge status={row.status} overdue={isOverdue(row, today)} />
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">{T.customer}: </span>
        {row.customerId ? (
          <Link href={`/zakaznici/${row.customerId}`} className="underline underline-offset-4">
            {row.customerName}
          </Link>
        ) : (
          row.customerName
        )}
        {" · "}
        <span className="text-muted-foreground">{T.total}: </span>
        {formatMoney(row.totalMinor, row.currency)}
        {" · "}
        <span className="text-muted-foreground">{T.dueDate}: </span>
        {row.dueDate ? formatCalendarDate(row.dueDate, "d. M. yyyy") : "–"}
      </p>
      {row.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <Badge key={tag.id} variant="outline">
              {tag.name}
            </Badge>
          ))}
        </div>
      )}
      <InvoiceActions
        id={id}
        editable={editable}
        cancellable={row.status === "issued" || row.status === "sent"}
        restorable={row.status === "cancelled" && row.cancelledFrom !== null}
        markable={row.status === "issued"}
        refreshable={editable && row.customerId !== null}
      />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg">{T.statusTitle}</h2>
        <StatusSteps row={row} />
        <p data-testid="invoice-qr" className="text-sm text-muted-foreground">
          {TEXTS.invoices.qr[qr]}
        </p>
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{TEXTS.invoices.versions.title}</h2>
        <VersionList invoiceId={id} versions={listVersions(user.id, id)} />
      </section>
      <section className="flex flex-col gap-3 sm:max-w-xl">
        <h2 className="text-lg">{T.historyTitle}</h2>
        <EntityHistory entity="invoice" entityId={id} />
      </section>
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
