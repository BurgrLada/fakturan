"use client";

import { useEffect, useState, useTransition } from "react";
import { bulkSendAction, bulkSendPreviewAction } from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoiceMail.bulk;

type Preview = Extract<Awaited<ReturnType<typeof bulkSendPreviewAction>>, { ok: true }>;

function Summary({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let current = true;
    bulkSendPreviewAction({ ids }).then(
      (reply) => {
        if (!current) return;
        if (reply.ok) setPreview(reply);
        else setError(reply.error);
      },
      () => {
        if (current) setError(T.failed);
      },
    );
    return () => {
      current = false;
    };
  }, [ids]);

  function send() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      try {
        const reply = await bulkSendAction({
          ids: preview.ready.map((row) => row.id),
          requestId: preview.requestId,
          previewed: Object.fromEntries(
            preview.ready.map(({ id, to, copies }) => [id, { to, copies }]),
          ),
        });
        if (!reply.ok) {
          setError(reply.error);
          return;
        }
        onDone(T.done(reply.queued, reply.skipped + preview.skipped.length, reply.reasons));
      } catch {
        setError(T.failed);
      }
    });
  }

  const copies = preview?.ready[0]?.copies ?? [];
  const loadFailed = !preview && error !== null;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{T.title}</AlertDialogTitle>
        {!loadFailed && (
          <AlertDialogDescription>
            {preview ? (preview.ready.length > 0 ? T.templateNote : T.nothing) : T.loading}
          </AlertDialogDescription>
        )}
      </AlertDialogHeader>
      {preview && preview.ready.length > 0 && (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">{T.summary(preview.ready.length)}</h3>
          <ul data-testid="bulk-ready" className="flex flex-col gap-1">
            {preview.ready.map((row) => (
              <li key={row.id} className="break-words">
                {row.number}, {row.customer}: {row.to.join(", ")}
              </li>
            ))}
          </ul>
          {copies.length > 0 && (
            <p className="text-muted-foreground">{T.copies(copies.join(", "))}</p>
          )}
        </section>
      )}
      {preview && preview.skipped.length > 0 && (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">{T.skippedTitle(preview.skipped.length)}</h3>
          <ul data-testid="bulk-skipped" className="flex flex-col gap-1">
            {preview.skipped.map((row) => (
              <li key={row.id} className="break-words">
                {row.number ? `${row.number}: ` : ""}
                {row.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview?.paused && (
        <Alert>
          <AlertDescription>{T.paused}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <AlertDialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          {T.cancel}
        </Button>
        <Button disabled={pending || !preview || preview.ready.length === 0} onClick={send}>
          {T.confirm(preview?.ready.length ?? 0)}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

export function BulkSendDialog({
  ids,
  open,
  onClose,
  onDone,
}: {
  ids: string[];
  open: boolean;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent size="lg" className="max-h-[90dvh] overflow-y-auto">
        <Summary ids={ids} onClose={onClose} onDone={onDone} />
      </AlertDialogContent>
    </AlertDialog>
  );
}
