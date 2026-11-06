"use client";

import { useState, useTransition } from "react";
import { createExportAction } from "@/app/(app)/nastaveni/export/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { NativeSelect } from "@/components/ui/native-select";
import { exportContents, FORMATS_BY_KIND, type ExportFormat } from "@/lib/export-filter";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.exporting;

export function BulkExportDialog({
  ids,
  open,
  onClose,
  onDone,
}: {
  ids: string[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("pdf_zip");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start() {
    setError(null);
    startTransition(async () => {
      try {
        const reply = await createExportAction({
          kind: "invoices",
          format,
          filter: { ids },
        });
        if (reply.ok) onDone();
        else setError(reply.error);
      } catch {
        setError(T.form.failed);
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.bulk.title}</AlertDialogTitle>
          <AlertDialogDescription>{T.bulk.body(ids.length)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor="bulk-export-format">{T.form.format}</Label>
          <NativeSelect
            id="bulk-export-format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
          >
            {FORMATS_BY_KIND.invoices.map((value) => (
              <option key={value} value={value}>
                {T.formats[value]}
              </option>
            ))}
          </NativeSelect>
          <p className="text-sm text-muted-foreground">{exportContents("invoices", format)}</p>
        </div>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{T.bulk.cancel}</AlertDialogCancel>
          <Button disabled={pending} onClick={start}>
            {T.bulk.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
