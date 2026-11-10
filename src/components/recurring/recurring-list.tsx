import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RecurringMode, RecurringStatus } from "@/lib/recurrence";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.recurring;

export type RecurringListRow = {
  id: string;
  name: string;
  customerId: string | null;
  customerName: string | null;
  nextIssueDate: string | null;
  mode: RecurringMode;
  status: RecurringStatus;
};

export function RecurringList({ rows }: { rows: RecurringListRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{T.columns.name}</TableHead>
          <TableHead>{T.columns.customer}</TableHead>
          <TableHead>{T.columns.next}</TableHead>
          <TableHead>{T.columns.mode}</TableHead>
          <TableHead>{T.columns.status}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} data-testid="plan-row">
            <TableCell className="whitespace-normal font-medium">
              <Link href={`/pravidelne/${row.id}`} className="underline underline-offset-4">
                {row.name}
              </Link>
            </TableCell>
            <TableCell className="whitespace-normal">
              {row.customerId && row.customerName ? (
                <Link
                  href={`/zakaznici/${row.customerId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {row.customerName}
                </Link>
              ) : (
                (row.customerName ?? <span className="text-muted-foreground">{T.noCustomer}</span>)
              )}
            </TableCell>
            <TableCell className="tabular-nums">
              {row.nextIssueDate ? formatCalendarDate(row.nextIssueDate, "d. M. yyyy") : T.noNext}
            </TableCell>
            <TableCell>{T.modes[row.mode]}</TableCell>
            <TableCell>
              <Badge variant={row.status === "active" ? "default" : "outline"}>
                {T.statuses[row.status]}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
