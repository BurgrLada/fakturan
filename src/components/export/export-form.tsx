"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { createExportAction, exportListAction } from "@/app/(app)/nastaveni/export/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  EXPORT_INVOICE_STATUSES,
  EXPORT_KINDS,
  exportContents,
  FORMATS_BY_KIND,
  type ExportFilter,
  type ExportFormat,
  type ExportKind,
} from "@/lib/export-filter";
import { formatDateTime } from "@/lib/format";
import { INVOICE_TYPES } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";
import type { ExportListRow } from "@/server/services/exports";

const T = TEXTS.exporting;
const POLL_MS = 1500;

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export function ExportForm({ customers }: { customers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<ExportKind>("invoices");
  const [format, setFormat] = useState<ExportFormat>("pdf_zip");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const dated = kind === "invoices" || kind === "payments";

  function chooseKind(next: ExportKind) {
    setKind(next);
    setFormat(FORMATS_BY_KIND[next][0]!);
  }

  function filter(): ExportFilter {
    const chosen: ExportFilter = {};
    if (dated && from) chosen.from = from;
    if (dated && to) chosen.to = to;
    if (kind === "invoices") {
      if (type) chosen.types = [type as (typeof INVOICE_TYPES)[number]];
      if (customerId) chosen.customerId = customerId;
      if (status) chosen.statuses = [status as (typeof EXPORT_INVOICE_STATUSES)[number]];
    }
    return chosen;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await createExportAction({ kind, format, filter: filter() });
        if (!reply.ok) return setMessage({ ok: false, text: reply.error });
        setMessage({ ok: true, text: T.form.started });
        router.refresh();
      } catch {
        setMessage({ ok: false, text: T.form.failed });
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 className="text-lg font-medium">{T.form.title}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="export-kind" label={T.form.kind}>
          <NativeSelect
            id="export-kind"
            value={kind}
            onChange={(event) => chooseKind(event.target.value as ExportKind)}
          >
            {EXPORT_KINDS.map((value) => (
              <option key={value} value={value}>
                {T.kinds[value]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="export-format" label={T.form.format}>
          <NativeSelect
            id="export-format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
          >
            {FORMATS_BY_KIND[kind].map((value) => (
              <option key={value} value={value}>
                {T.formats[value]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {dated && (
          <>
            <Field id="export-from" label={kind === "payments" ? T.form.paidFrom : T.form.from}>
              <Input
                id="export-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field id="export-to" label={kind === "payments" ? T.form.paidTo : T.form.to}>
              <Input
                id="export-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </>
        )}
        {kind === "invoices" && (
          <>
            <Field id="export-type" label={T.form.type}>
              <NativeSelect
                id="export-type"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="">{T.form.anyType}</option>
                {INVOICE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {TEXTS.invoices.list.types[value]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="export-customer" label={T.form.customer}>
              <NativeSelect
                id="export-customer"
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
              >
                <option value="">{T.form.anyCustomer}</option>
                {customers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="export-status" label={T.form.status}>
              <NativeSelect
                id="export-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">{T.form.anyStatus}</option>
                {EXPORT_INVOICE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {TEXTS.invoices.statuses[value]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground" data-testid="export-contents">
        {exportContents(kind, format)}
      </p>
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {T.form.start}
        </Button>
      </div>
    </form>
  );
}

const RUNNING = new Set<ExportListRow["status"]>(["queued", "running"]);

export function ExportList({ initial }: { initial: ExportListRow[] }) {
  const [rows, setRows] = useState(initial);
  const running = rows.some((row) => RUNNING.has(row.status));

  useEffect(() => setRows(initial), [initial]);

  useEffect(() => {
    if (!running) return;
    let current = true;
    const timer = setInterval(() => {
      exportListAction().then(
        (reply) => {
          if (current && reply.ok) setRows(reply.rows);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [running]);

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{T.list.empty}</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm" aria-label={T.list.title}>
      {rows.map((row) => (
        <li
          key={row.id}
          data-testid="export-row"
          className="flex flex-wrap items-center justify-between gap-2 p-3"
        >
          <span className="flex flex-col gap-1">
            <span>
              {formatDateTime(row.createdAt)} · {T.kinds[row.kind]} · {T.formats[row.format]} ·{" "}
              <span data-testid="export-status">{T.statuses[row.status]}</span>
              {row.status === "running" &&
                row.progressTotal > 0 &&
                ` · ${T.list.progress(row.progress, row.progressTotal)}`}
            </span>
            {row.status === "failed" && row.reason && (
              <span className="text-destructive">{row.reason}</span>
            )}
          </span>
          {row.downloadable && (
            <span className="flex items-center gap-2">
              {row.expiresAt && (
                <span className="text-muted-foreground">
                  {T.list.expires(formatDateTime(row.expiresAt))}
                </span>
              )}
              <a href={`/nastaveni/export/${row.id}`} className="underline underline-offset-4">
                {T.list.download}
              </a>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
