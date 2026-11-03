"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ChangeEvent } from "react";
import { importDashboardAction, previewImportAction } from "@/app/(app)/dashboardy/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { defaultSize } from "@/lib/dashboard-defaults";
import { MAX_FILE_BYTES } from "@/lib/dashboard-share";
import { mayLeave } from "@/lib/leave-guard";
import type { DateFormat } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import type { ImportPreview } from "@/server/services/dashboards";
import { widgetUnit } from "./widget-number";
import { WidgetErrorBoundary } from "./widget-error";
import { widgetTitle, WidgetView } from "./widget-view";

const S = TEXTS.dashboard.share;
const X = TEXTS.dashboard.edit;

type Loaded = { text: string; preview: ImportPreview };

function PreviewList({ preview, dateFormat }: { preview: ImportPreview; dateFormat: DateFormat }) {
  return (
    <div className="flex flex-col gap-3" data-testid="import-preview">
      <p className="text-sm font-medium">{S.previewTitle(preview.name)}</p>
      <p className="text-xs text-muted-foreground">
        {S.widgets(preview.widgets.length)}. {S.previewNote}
      </p>
      {preview.addedPinned && <p className="text-xs text-muted-foreground">{S.addedPinned}</p>}
      <ul className="flex flex-col gap-3">
        {preview.widgets.map((widget, index) => {
          const title = widgetTitle(widget.config);
          return (
            <li
              key={index}
              aria-label={title}
              data-testid="import-widget"
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
            >
              <h3 className="text-sm font-medium">{title}</h3>
              {widget.droppedCustomers && (
                <p role="note" className="text-xs text-muted-foreground">
                  {S.droppedCustomers}
                </p>
              )}
              {widget.ok ? (
                <WidgetErrorBoundary>
                  <WidgetView
                    config={widget.config}
                    result={widget.result}
                    unit={widgetUnit(widget.config, {})}
                    title={title}
                    h={defaultSize(widget.config).h}
                    dateFormat={dateFormat}
                  />
                </WidgetErrorBoundary>
              ) : (
                <p className="text-sm text-muted-foreground">{widget.error}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// DSH-031, DSH-032: the file is checked on the server and previewed over the account's own data;
// only the confirm button writes, and it sends the same text to be checked again.
export function ImportDialog({ dateFormat }: { dateFormat: DateFormat }) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setLoaded(null);
    setError(null);
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setLoaded(null);
    setError(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(S.tooLarge(MAX_FILE_BYTES / 1024));
      return;
    }
    startTransition(async () => {
      try {
        const text = await file.text();
        const reply = await previewImportAction({ text });
        if (!reply.ok) {
          setError(reply.expired ? X.expired : reply.error);
          return;
        }
        setLoaded({ text, preview: reply.preview });
      } catch {
        setError(S.failed);
      }
    });
  }

  function confirm() {
    if (!loaded) return;
    startTransition(async () => {
      if (!(await mayLeave())) return;
      try {
        const reply = await importDashboardAction({ text: loaded.text });
        if (!reply.ok) {
          setError(reply.expired ? X.expired : reply.error);
          return;
        }
        close();
        router.push(`/dashboardy/${reply.id}/upravit`);
      } catch {
        setError(S.failed);
      }
    });
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Upload aria-hidden />
        {S.import}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !next && close()}>
        <AlertDialogContent size="lg" className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{S.importTitle}</AlertDialogTitle>
            <AlertDialogDescription>{S.importBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>{S.file}</Label>
            <input
              id={inputId}
              type="file"
              accept="application/json,.json"
              onChange={choose}
              disabled={pending}
              className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1 file:text-sm"
            />
          </div>
          {pending && !loaded && (
            <p role="status" className="text-sm text-muted-foreground">
              {S.previewing}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="import-error">
              {error}
            </p>
          )}
          {loaded && <PreviewList preview={loaded.preview} dateFormat={dateFormat} />}
          <AlertDialogFooter>
            <AlertDialogCancel>{S.cancel}</AlertDialogCancel>
            <Button type="button" onClick={confirm} disabled={!loaded || pending}>
              {S.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
