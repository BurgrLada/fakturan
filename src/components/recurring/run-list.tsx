"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resolveMissedAction } from "@/app/(app)/pravidelne/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.recurring;
const D = T.detail;

export type RunListRow = {
  id: string;
  plannedDate: string;
  periodFrom: string;
  periodTo: string;
  status: keyof typeof T.runStatuses;
  invoiceId: string | null;
  invoiceNumber: string | null;
  reason: string | null;
};

const date = (value: string) => formatCalendarDate(value, "d. M. yyyy");
const period = (row: RunListRow) => `${date(row.periodFrom)} – ${date(row.periodTo)}`;

// Plain anchors: the invoice is brand new, and a Link would prefetch and cache the route before it exists.
function InvoiceLink({ row }: { row: RunListRow }) {
  if (!row.invoiceId) return <span className="text-muted-foreground">–</span>;
  return (
    <a href={`/faktury/${row.invoiceId}`} className="underline underline-offset-4">
      {row.invoiceNumber ?? D.openDraft}
    </a>
  );
}

export function RunList({ rows }: { rows: RunListRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{D.noRuns}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{D.runColumns.planned}</TableHead>
          <TableHead>{D.runColumns.period}</TableHead>
          <TableHead>{D.runColumns.status}</TableHead>
          <TableHead>{D.runColumns.invoice}</TableHead>
          <TableHead>{D.runColumns.reason}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} data-testid="run-row">
            <TableCell className="tabular-nums">{date(row.plannedDate)}</TableCell>
            <TableCell className="whitespace-normal tabular-nums">{period(row)}</TableCell>
            <TableCell>{T.runStatuses[row.status]}</TableCell>
            <TableCell>
              <InvoiceLink row={row} />
            </TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">
              {row.reason ?? ""}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Done = { row: RunListRow; invoiceId: string | null };

export function MissedReview({ rows }: { rows: RunListRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);

  const resolved = new Set(done.map((item) => item.row.id));
  const open = rows.filter((row) => !resolved.has(row.id));
  if (open.length === 0 && done.length === 0) return null;

  function resolve(row: RunListRow, action: "draft" | "skip") {
    setError(null);
    startTransition(async () => {
      try {
        const reply = await resolveMissedAction({ runId: row.id, action });
        if (!reply.ok) {
          setError(reply.error);
          return;
        }
        setDone((current) => [...current, { row, invoiceId: reply.invoiceId }]);
        router.refresh();
      } catch {
        setError(T.actions.failed);
      }
    });
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="review-title" data-testid="review">
      <h2 id="review-title" className="text-lg">
        {D.review}
      </h2>
      <p className="text-sm text-muted-foreground">{D.reviewBody}</p>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ul className="flex flex-col gap-2">
        {open.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
          >
            <span className="text-sm">
              {date(row.plannedDate)}
              <span className="text-muted-foreground">
                {" · "}
                {period(row)}
                {row.reason ? ` · ${row.reason}` : ""}
              </span>
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                disabled={pending}
                aria-label={`${D.createDraft}: ${date(row.plannedDate)}`}
                onClick={() => resolve(row, "draft")}
              >
                {D.createDraft}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                aria-label={`${D.skip}: ${date(row.plannedDate)}`}
                onClick={() => resolve(row, "skip")}
              >
                {D.skip}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <ul className="flex flex-col gap-1" role="status">
          {done.map(({ row, invoiceId }) => (
            <li key={row.id} className="text-sm">
              {date(row.plannedDate)}
              {": "}
              {invoiceId ? (
                <>
                  {D.draftCreated}{" "}
                  <a
                    href={`/faktury/${invoiceId}/upravit`}
                    className="underline underline-offset-4"
                  >
                    {D.openDraft}
                  </a>
                </>
              ) : (
                D.skipped
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
