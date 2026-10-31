import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { AlertRow } from "@/server/services/due-alerts";

const T = TEXTS.reminders.alerts;
const MAX_ROWS = 5;

function Group({
  title,
  rows,
  testId,
  href,
}: {
  title: string;
  rows: AlertRow[];
  testId: string;
  href: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <h3 className="text-sm font-medium">
        {title} ({rows.length})
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.slice(0, MAX_ROWS).map((row) => (
          <li key={row.id} className="flex flex-wrap gap-x-2">
            <Link href={`/faktury/${row.id}`} className="underline underline-offset-4">
              {row.number}
            </Link>
            <span>{row.customerName}</span>
            <span className="text-muted-foreground">
              {T.due} {formatCalendarDate(row.dueDate, "d. M. yyyy")}
            </span>
            <span>{formatMoney(row.amountDueMinor, row.currency)}</span>
          </li>
        ))}
      </ul>
      <Link href={href} className="text-sm underline underline-offset-4">
        {T.all}
      </Link>
    </div>
  );
}

export function DueAlerts({ overdue, dueSoon }: { overdue: AlertRow[]; dueSoon: AlertRow[] }) {
  if (overdue.length + dueSoon.length === 0) return null;
  return (
    <section
      aria-labelledby="due-alerts-title"
      className="flex flex-col gap-3 rounded-lg border p-4 sm:max-w-xl"
    >
      <h2 id="due-alerts-title" className="text-lg">
        {T.title}
      </h2>
      <Group
        title={T.overdue}
        rows={overdue}
        testId="alerts-overdue"
        href="/faktury?stav=po-splatnosti"
      />
      <Group
        title={T.dueSoon}
        rows={dueSoon}
        testId="alerts-due-soon"
        href="/faktury?razeni=splatnost&smer=asc"
      />
    </section>
  );
}
