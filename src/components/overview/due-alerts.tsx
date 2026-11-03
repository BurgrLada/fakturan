import Link from "next/link";
import { formatMoney } from "@/lib/money";
import type { DateFormat } from "@/lib/preferences";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { AlertRow } from "@/server/services/due-alerts";

const T = TEXTS.reminders.alerts;

function Group({
  title,
  rows,
  testId,
  href,
  dateFormat,
  limit,
}: {
  title: string;
  rows: AlertRow[];
  dateFormat: DateFormat;
  testId: string;
  href: string;
  limit: number;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <h3 className="text-sm font-medium">
        {title} ({rows.length})
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.slice(0, limit).map((row) => (
          <li key={row.id} className="flex flex-wrap gap-x-2">
            <Link href={`/faktury/${row.id}`} className="underline underline-offset-4">
              {row.number}
            </Link>
            <span>{row.customerName}</span>
            <span className="text-muted-foreground">
              {T.due} {formatCalendarDate(row.dueDate, dateFormat)}
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

// The card around it is the pinned due_alerts widget, which gives it its title (R-20).
export function DueAlerts({
  overdue,
  dueSoon,
  dateFormat,
  limit,
}: {
  overdue: AlertRow[];
  dueSoon: AlertRow[];
  dateFormat: DateFormat;
  limit: number;
}) {
  if (overdue.length + dueSoon.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <Group
        title={T.overdue}
        rows={overdue}
        testId="alerts-overdue"
        dateFormat={dateFormat}
        limit={limit}
        href="/faktury?stav=po-splatnosti"
      />
      <Group
        title={T.dueSoon}
        rows={dueSoon}
        testId="alerts-due-soon"
        dateFormat={dateFormat}
        limit={limit}
        href="/faktury?razeni=splatnost&smer=asc"
      />
    </div>
  );
}
