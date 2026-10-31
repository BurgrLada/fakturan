"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { markSentManyAction } from "@/app/(app)/faktury/actions";
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
import { formatMoney } from "@/lib/money";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { InvoiceRow, InvoiceSort, SortLink } from "@/server/services/invoices";
import { InvoiceStatusBadge } from "./invoice-status";

const T = TEXTS.invoices.list;
const NARROW_HIDDEN = "hidden sm:table-cell";

const COLUMNS: { sort: InvoiceSort; label: string; className?: string }[] = [
  { sort: "number", label: T.columns.number },
  { sort: "customer", label: T.columns.customer },
  { sort: "issueDate", label: T.columns.issueDate, className: NARROW_HIDDEN },
  { sort: "dueDate", label: T.columns.dueDate, className: NARROW_HIDDEN },
  { sort: "total", label: T.columns.total, className: "text-right" },
  { sort: "status", label: T.columns.status },
];

const SORT_STATE = { asc: "ascending", desc: "descending" } as const;

const shortDate = (date: string | null) => (date ? formatCalendarDate(date, "d. M. yyyy") : "–");

function failureText(status: number): string {
  if (status === 429) return T.bulk.busy;
  if (status === 404) return T.bulk.gone;
  return T.bulk.failed;
}

async function downloadZip(ids: string[]): Promise<string | null> {
  const response = await fetch("/faktury/hromadne-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) return failureText(response.status);
  const name = /filename\*=UTF-8''([^;]+)/.exec(
    response.headers.get("Content-Disposition") ?? "",
  )?.[1];
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name ? decodeURIComponent(name) : T.bulk.fallbackName;
  link.click();
  URL.revokeObjectURL(url);
  return null;
}

export function InvoiceTable({
  rows,
  sortLinks,
}: {
  rows: InvoiceRow[];
  sortLinks: Record<InvoiceSort, SortLink>;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const selectable = rows.filter((row) => row.status !== "draft");
  const chosen = selectable.filter((row) => selected.has(row.id)).map((row) => row.id);
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function download() {
    setMessage(null);
    startTransition(async () => {
      try {
        const error = await downloadZip(chosen);
        if (error) setMessage({ ok: false, text: error });
      } catch {
        setMessage({ ok: false, text: T.bulk.failed });
      }
    });
  }

  function markSent() {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await markSentManyAction({ ids: chosen });
        if (!result.ok) {
          setMessage({ ok: false, text: result.error });
          return;
        }
        setSelected(new Set());
        setMessage({ ok: true, text: T.bulk.marked(result.done, result.skipped) });
      } catch {
        setMessage({ ok: false, text: T.bulk.failed });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {chosen.length > 0 && (
        <div
          role="group"
          aria-label={T.bulk.title}
          className="flex flex-wrap items-center gap-2 rounded-md border p-2"
        >
          <span className="text-sm">{T.bulk.count(chosen.length)}</span>
          <Button variant="outline" size="sm" disabled={pending} onClick={download}>
            {T.bulk.download}
          </Button>
          <Button variant="outline" size="sm" disabled={pending} onClick={markSent}>
            {T.bulk.markSent}
          </Button>
        </div>
      )}
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <input
                type="checkbox"
                aria-label={T.bulk.selectAll}
                disabled={selectable.length === 0}
                checked={allChosen}
                onChange={(event) =>
                  setSelected(new Set(event.target.checked ? selectable.map((r) => r.id) : []))
                }
              />
            </TableHead>
            {COLUMNS.map(({ sort, label, className }) => {
              const link = sortLinks[sort];
              return (
                <TableHead
                  key={sort}
                  className={className}
                  aria-sort={link.active ? SORT_STATE[link.active] : undefined}
                >
                  <Link href={link.href} className="inline-flex items-center gap-1 hover:underline">
                    {label}
                    {link.active === "asc" && <ArrowUp aria-hidden className="size-3" />}
                    {link.active === "desc" && <ArrowDown aria-hidden className="size-3" />}
                  </Link>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                {row.status !== "draft" && (
                  <input
                    type="checkbox"
                    aria-label={T.bulk.select(row.number ?? "")}
                    checked={selected.has(row.id)}
                    onChange={(event) => toggle(row.id, event.target.checked)}
                  />
                )}
              </TableCell>
              <TableCell>
                <Link
                  href={
                    row.status === "draft" ? `/faktury/${row.id}/upravit` : `/faktury/${row.id}`
                  }
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {row.number ?? TEXTS.invoices.statuses.draft}
                </Link>
              </TableCell>
              <TableCell className="whitespace-normal">{row.customerName || "–"}</TableCell>
              <TableCell className={NARROW_HIDDEN}>{shortDate(row.issueDate)}</TableCell>
              <TableCell className={NARROW_HIDDEN}>{shortDate(row.dueDate)}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {formatMoney(row.totalMinor, row.currency)}
              </TableCell>
              <TableCell>
                <InvoiceStatusBadge status={row.status} overdue={row.overdue} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
