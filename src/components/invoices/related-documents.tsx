import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import type { RelatedDocument } from "@/server/services/credit-notes";
import { InvoiceStatusBadge } from "./invoice-status";

const T = TEXTS.invoices.detail.related;

function Row({ row }: { row: RelatedDocument }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{TEXTS.invoices.list.types[row.type]}</span>
      <Link href={`/faktury/${row.id}`} className="underline underline-offset-4">
        {row.number ?? TEXTS.invoices.statuses.draft}
      </Link>
      <span>{formatMoney(row.totalMinor, row.currency)}</span>
      <InvoiceStatusBadge status={row.status} overdue={false} />
    </li>
  );
}

export function RelatedDocuments({
  parent,
  childDocuments,
}: {
  parent: RelatedDocument | null;
  childDocuments: RelatedDocument[];
}) {
  if (!parent && childDocuments.length === 0) return null;
  return (
    <section data-testid="related-documents" className="flex flex-col gap-2 text-sm sm:max-w-xl">
      <h2 className="text-lg">{T.title}</h2>
      {parent && (
        <>
          <h3 className="text-muted-foreground">{T.parent}</h3>
          <ul>
            <Row row={parent} />
          </ul>
        </>
      )}
      {childDocuments.length > 0 && (
        <>
          <h3 className="text-muted-foreground">{T.children}</h3>
          <ul className="flex flex-col gap-1">
            {childDocuments.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
