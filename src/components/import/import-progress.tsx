"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { importStateAction, type ImportState } from "@/app/(app)/nastaveni/import/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TEXTS } from "@/lib/texts";
import { ImportPreview } from "./import-preview";

const T = TEXTS.importing;
const POLL_MS = 1000;
const RUNNING = new Set(["uploading", "parsing", "committing"]);

export function ImportProgress({ initial }: { initial: ImportState }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const running = RUNNING.has(state.batch.status);
  const mapping = state.batch.status === "mapping";

  // The column mapper is rendered by the page from the sample, so the page has to load again.
  useEffect(() => {
    if (mapping) router.refresh();
  }, [mapping, router]);

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(async () => {
      const next = await importStateAction({ batchId: state.batch.id });
      if (next.ok) setState({ batch: next.batch, rows: next.rows });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [running, state]);

  const { batch } = state;
  return (
    <div className="space-y-4">
      <p className="text-sm" data-testid="import-status">
        {T.statuses[batch.status]}
        {batch.status === "parsing" && ` · ${T.progress(batch.progress)}`}
      </p>
      {batch.error && (
        <Alert variant={batch.status === "failed" ? "destructive" : "default"} role="status">
          <AlertDescription className="whitespace-pre-line">{batch.error}</AlertDescription>
        </Alert>
      )}
      {batch.status === "done" && (
        <p className="text-sm" role="status">
          {batch.kind === "tabular" && batch.target !== "invoices"
            ? T.preview.doneRecords(batch.summary?.documents ?? 0)
            : T.preview.done(batch.summary?.documents ?? 0)}
        </p>
      )}
      {batch.status === "undone" && <p className="text-sm">{T.preview.undone}</p>}
      {(batch.status === "ready" || batch.status === "done") && (
        <ImportPreview state={state} onChange={setState} />
      )}
    </div>
  );
}
