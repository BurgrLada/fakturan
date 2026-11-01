import Link from "next/link";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status";
import { formatMoney } from "@/lib/money";
import { days } from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import { customerInvoiceStats } from "@/server/services/invoices";

const T = TEXTS.customers.invoices;

export function CustomerInvoices({ ownerId, customerId }: { ownerId: string; customerId: string }) {
  const { sums, rows, hasMore, averageDays } = customerInvoiceStats(ownerId, customerId);
  return (
    <section className="flex flex-col gap-3 sm:max-w-xl">
      <h2 className="text-lg">{T.title}</h2>
      <p className="text-sm" data-testid="customer-average-days">
        <span className="text-muted-foreground">{T.averageDays}: </span>
        {averageDays === null ? T.noAverage : days(Math.round(averageDays))}
      </p>
      {sums.map((sum) => (
        <dl
          key={sum.currency}
          data-testid={`customer-sum-${sum.currency}`}
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border p-3 text-sm"
        >
          <dt className="text-muted-foreground">{T.invoiced}</dt>
          <dd className="text-right">{formatMoney(sum.invoicedMinor, sum.currency)}</dd>
          <dt className="text-muted-foreground">{T.paid}</dt>
          <dd className="text-right">{formatMoney(sum.paidMinor, sum.currency)}</dd>
          <dt className="text-muted-foreground">{T.outstanding}</dt>
          <dd className="text-right">{formatMoney(sum.outstandingMinor, sum.currency)}</dd>
          {sum.advanceOpenMinor > 0 && (
            <>
              <dt className="text-muted-foreground">{T.advanceOpen}</dt>
              <dd className="text-right">{formatMoney(sum.advanceOpenMinor, sum.currency)}</dd>
            </>
          )}
        </dl>
      ))}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.empty}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <Link
                href={row.status === "draft" ? `/faktury/${row.id}/upravit` : `/faktury/${row.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {row.number ?? TEXTS.invoices.statuses.draft}
              </Link>
              <span className="whitespace-nowrap">{formatMoney(row.totalMinor, row.currency)}</span>
              <InvoiceStatusBadge status={row.status} overdue={row.overdue} />
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Link
          href={`/faktury?zakaznik=${customerId}`}
          className="text-sm underline underline-offset-4"
        >
          {T.all}
        </Link>
      )}
    </section>
  );
}
