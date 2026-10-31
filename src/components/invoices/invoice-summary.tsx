import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import type { InvoiceSummaryRow } from "@/server/services/invoices";

const T = TEXTS.invoices.list.summary;

export function InvoiceSummary({ rows }: { rows: InvoiceSummaryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={T.title} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <dl
          key={row.currency}
          data-testid={`summary-${row.currency}`}
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border p-3 text-sm"
        >
          <dt className="text-muted-foreground">{T.invoiced}</dt>
          <dd className="text-right">{formatMoney(row.invoicedMinor, row.currency)}</dd>
          <dt className="text-muted-foreground">{T.paid}</dt>
          <dd className="text-right">{formatMoney(row.paidMinor, row.currency)}</dd>
          <dt className="text-muted-foreground">{T.overdue}</dt>
          <dd className={`text-right ${row.overdueMinor > 0 ? "text-destructive" : ""}`}>
            {formatMoney(row.overdueMinor, row.currency)}
          </dd>
        </dl>
      ))}
    </section>
  );
}
