import { FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { InvoiceFilters } from "@/components/invoices/invoice-filters";
import { Remount } from "@/components/invoices/remount";
import { InvoiceSummary } from "@/components/invoices/invoice-summary";
import { InvoiceTable } from "@/components/invoices/invoice-table";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { ADVANCE_FORM_PARAM } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { mailAvailability } from "@/server/services/mail-settings";
import {
  invoiceFilterOptions,
  invoiceQuery,
  invoiceSortLinks,
  invoiceSummary,
  isFiltered,
  listInvoices,
  parseInvoiceFilter,
} from "@/server/services/invoices";

const T = TEXTS.invoices.list;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

// Not a Link: the client router replays its cached redirect to the previous draft's id, which shows
// that draft for a moment and lets typing land in it, even with prefetch off.
function NewInvoiceLink({ variant }: { variant?: "outline" }) {
  return (
    <a href="/faktury/nova" className={buttonVariants({ variant })}>
      {TEXTS.invoices.add}
    </a>
  );
}

async function InvoicesContent({ searchParams }: Pick<PageProps<"/faktury">, "searchParams">) {
  const { user } = await requireSession();
  const filter = parseInvoiceFilter(await searchParams);
  const result = listInvoices(user.id, filter);
  const filtered = isFiltered(filter);
  const pastEnd = result.rows.length === 0 && result.page > 1;
  return (
    <>
      <Remount on={invoiceQuery(filter)}>
        <InvoiceFilters filter={filter} options={invoiceFilterOptions(user.id)} />
      </Remount>
      <InvoiceSummary rows={invoiceSummary(user.id, filter)} />
      {result.rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={pastEnd ? T.emptyPage : filtered ? T.emptyFiltered : T.empty}
          description={filtered || pastEnd ? "" : T.emptyBody}
          action={
            pastEnd ? (
              <Link
                href={`/faktury${invoiceQuery({ ...filter, page: 1 })}`}
                className={buttonVariants({ variant: "outline" })}
              >
                {T.firstPage}
              </Link>
            ) : filtered ? (
              <Link href="/faktury" className={buttonVariants({ variant: "outline" })}>
                {T.reset}
              </Link>
            ) : (
              <NewInvoiceLink variant="outline" />
            )
          }
        />
      ) : (
        <InvoiceTable
          key={invoiceQuery(filter)}
          rows={result.rows}
          sortLinks={invoiceSortLinks(filter)}
          mailAvailable={mailAvailability(user.id).available}
        />
      )}
      <div className="flex gap-2">
        {result.page > 1 && (
          <Link
            href={`/faktury${invoiceQuery({ ...filter, page: result.page - 1 })}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {T.newer}
          </Link>
        )}
        {result.hasNext && (
          <Link
            href={`/faktury${invoiceQuery({ ...filter, page: result.page + 1 })}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {T.older}
          </Link>
        )}
      </div>
    </>
  );
}

export default function InvoicesPage({ searchParams }: PageProps<"/faktury">) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-brand text-2xl">{T.title}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/faktury/sablony" className={buttonVariants({ variant: "outline" })}>
            {T.templates}
          </Link>
          <a
            href={`/faktury/nova?typ=${ADVANCE_FORM_PARAM}`}
            className={buttonVariants({ variant: "outline" })}
          >
            {TEXTS.invoices.addAdvance}
          </a>
          <NewInvoiceLink />
        </div>
      </div>
      <Suspense fallback={<PageLoading />}>
        <InvoicesContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
