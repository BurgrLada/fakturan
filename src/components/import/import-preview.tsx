"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  confirmBatchAction,
  editPreviewAction,
  importStateAction,
  undoBatchAction,
  type ImportState,
} from "@/app/(app)/nastaveni/import/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { rowBlocks, type PreviewChange, type PreviewRow } from "@/lib/import-preview";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.importing.preview;
const TYPES = TEXTS.invoices.list.types;

type Props = { state: ImportState; onChange: (state: ImportState) => void };

const VARIANT = {
  ok: "secondary",
  warning: "outline",
  error: "destructive",
  duplicate: "outline",
  skipped: "ghost",
} as const;

function CustomerCell({
  row,
  onPick,
}: {
  row: PreviewRow;
  onPick: (customerId: string | null) => void;
}) {
  const action = row.customerAction;
  if (action.kind === "existing") return <>{action.name}</>;
  if (action.kind === "create") return <>{T.newCustomer(action.name)}</>;
  if (action.kind === "none") return <>{T.noCustomer}</>;
  return (
    <NativeSelect
      aria-label={T.chooseCustomer}
      defaultValue=""
      onChange={(event) => onPick(event.target.value === "new" ? null : event.target.value)}
    >
      <option value="" disabled>
        {T.chooseCustomer}
      </option>
      {action.options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
          {option.archived ? ` (${T.archived})` : ""}
        </option>
      ))}
      <option value="new">{T.newCustomer(row.document?.customer?.name ?? "")}</option>
    </NativeSelect>
  );
}

export function ImportPreview({ state, onChange }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { batch, rows } = state;
  const ready = batch.status === "ready";

  const reload = async () => {
    const next = await importStateAction({ batchId: batch.id });
    if (next.ok) onChange({ batch: next.batch, rows: next.rows });
  };

  const edit = (change: PreviewChange) =>
    startTransition(async () => {
      setError(null);
      const result = await editPreviewAction({
        batchId: batch.id,
        revision: batch.revision,
        change,
      });
      if (!result.ok) setError(result.error);
      await reload();
    });

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const result = await confirmBatchAction({ batchId: batch.id, revision: batch.revision });
      if (!result.ok) return setError(result.error);
      await reload();
    });

  const undo = () =>
    startTransition(async () => {
      if (!window.confirm(T.undoConfirm)) return;
      const result = await undoBatchAction({ batchId: batch.id });
      if (!result.ok) return setError(result.error);
      await reload();
      router.refresh();
    });

  const keys = [...selected];
  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const paidCount = rows.filter((row) => row.paidMinor > 0 && row.status !== "skipped").length;
  const blocked = rows.some(rowBlocks);

  return (
    <div className="space-y-3">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {ready && (
        <>
          <p className="text-sm text-muted-foreground">{T.withTax}</p>
          {paidCount > 0 && <p className="text-sm">{T.paidCount(paidCount)}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <Input
              type="date"
              aria-label={T.dateFor}
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-auto"
            />
            <Button
              variant="outline"
              disabled={pending || keys.length === 0 || !date}
              onClick={() => edit({ kind: "paidOn", keys, mode: "date", date })}
            >
              {T.setDate}
            </Button>
            <Button
              variant="outline"
              disabled={pending || keys.length === 0}
              onClick={() => edit({ kind: "paidOn", keys, mode: "due" })}
            >
              {T.byDue}
            </Button>
            <Button
              variant="outline"
              disabled={pending || keys.length === 0}
              onClick={() => edit({ kind: "paidOn", keys, mode: "issue" })}
            >
              {T.byIssue}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={T.title}>
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">
                    <input
                      type="checkbox"
                      aria-label={T.selectAll}
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked ? new Set(rows.map((r) => r.key)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="p-2">{T.source}</th>
                  <th className="p-2">{T.number}</th>
                  <th className="p-2">{T.type}</th>
                  <th className="p-2">{T.customer}</th>
                  <th className="p-2 text-right">{T.total}</th>
                  <th className="p-2">{T.paidOn}</th>
                  <th className="p-2">{T.status}</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const doc = row.document;
                  return (
                    <tr
                      key={row.key}
                      className="border-b align-top"
                      data-testid={`import-row-${row.key}`}
                    >
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={row.source}
                          checked={selected.has(row.key)}
                          onChange={() => toggle(row.key)}
                        />
                      </td>
                      <td className="max-w-48 truncate p-2" title={row.source}>
                        {row.source}
                      </td>
                      <td className="p-2">{doc?.number ?? ""}</td>
                      <td className="p-2">{doc?.type ? TYPES[doc.type] : ""}</td>
                      <td className="p-2">
                        <CustomerCell
                          row={row}
                          onPick={(customerId) =>
                            edit({ kind: "customer", keys: [row.key], customerId })
                          }
                        />
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {doc && (CURRENCIES as readonly string[]).includes(doc.currency)
                          ? formatMoney(doc.totalMinor, doc.currency as Currency)
                          : (doc?.currency ?? "")}
                      </td>
                      <td className="p-2">
                        {row.paidOn ?? ""}
                        {row.paidOn && row.dateEstimated && (
                          <span className="text-muted-foreground"> ({T.estimated})</span>
                        )}
                      </td>
                      <td className="p-2">
                        <Badge variant={VARIANT[row.status]}>{T.statuses[row.status]}</Badge>
                        {row.messages.map((message) => (
                          <p key={message} className="mt-1 text-xs text-muted-foreground">
                            {message}
                          </p>
                        ))}
                      </td>
                      <td className="space-y-1 p-2">
                        {row.ownConfirmed === false && row.status !== "skipped" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => edit({ kind: "confirmOwn", keys: [row.key] })}
                          >
                            {T.confirmOwn}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() =>
                            edit({ kind: "skip", keys: [row.key], skip: row.status !== "skipped" })
                          }
                        >
                          {row.status === "skipped" ? T.unskip : T.skip}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {blocked && <p className="text-sm text-muted-foreground">{T.confirmHint}</p>}
          <Button disabled={pending || blocked} onClick={confirm}>
            {T.confirm}
          </Button>
        </>
      )}
      {batch.status === "done" && (
        <Button variant="outline" disabled={pending} onClick={undo}>
          {T.undo}
        </Button>
      )}
    </div>
  );
}
