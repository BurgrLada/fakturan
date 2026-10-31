"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  cancelInvoiceAction,
  duplicateInvoiceAction,
  markSentAction,
  refreshCustomerAction,
  restoreInvoiceAction,
} from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { SaveTemplateDialog, TemplatesLink } from "./save-template-dialog";

const T = TEXTS.invoices.detail;
const TPL = TEXTS.invoices.templates.save;

type Reply = { ok: boolean; error?: string };

export function InvoiceActions({
  id,
  editable,
  cancellable,
  restorable,
  markable,
  refreshable,
}: {
  id: string;
  editable: boolean;
  cancellable: boolean;
  restorable: boolean;
  markable: boolean;
  refreshable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [naming, setNaming] = useState(false);

  function perform(work: () => Promise<Reply>, done?: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await work();
        if (!reply.ok) setMessage({ ok: false, text: reply.error ?? T.failed });
        else if (done) setMessage({ ok: true, text: done });
      } catch {
        setMessage({ ok: false, text: T.failed });
      }
    });
  }

  function duplicate() {
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await duplicateInvoiceAction({ id });
        if (reply.ok) router.push(`/faktury/${reply.id}/upravit`);
        else setMessage({ ok: false, text: reply.error });
      } catch {
        setMessage({ ok: false, text: T.failed });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/faktury/${id}/pdf`} className={buttonVariants({ variant: "outline" })}>
          {T.download}
        </a>
        {editable && (
          <Link href={`/faktury/${id}/upravit`} className={buttonVariants({ variant: "outline" })}>
            {T.edit}
          </Link>
        )}
        <Button variant="outline" disabled={pending} onClick={duplicate}>
          {T.duplicate}
        </Button>
        <Button variant="outline" disabled={pending} onClick={() => setNaming(true)}>
          {TPL.trigger}
        </Button>
        <SaveTemplateDialog
          id={id}
          open={naming}
          notice={TPL.substituted}
          onOpenChange={setNaming}
          onResult={setMessage}
        />
        {markable && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => perform(() => markSentAction({ id }))}
          >
            {T.markSent}
          </Button>
        )}
        {refreshable && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => perform(() => refreshCustomerAction({ id }), T.refreshed)}
          >
            {T.refreshCustomer}
          </Button>
        )}
        {restorable && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => perform(() => restoreInvoiceAction({ id }))}
          >
            {T.restore}
          </Button>
        )}
        {cancellable && (
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogTrigger render={<Button variant="destructive" disabled={pending} />}>
              {T.cancel}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{T.cancelTitle}</AlertDialogTitle>
                <AlertDialogDescription>{T.cancelBody}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{T.cancelBack}</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirming(false);
                    perform(() => cancelInvoiceAction({ id }));
                  }}
                >
                  {T.cancelConfirm}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <Button disabled aria-describedby={`send-later-${id}`}>
          {T.send}
        </Button>
      </div>
      <p id={`send-later-${id}`} className="text-sm text-muted-foreground">
        {T.sendLater}
      </p>
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>
            {message.text}
            {message.ok && message.text === TPL.saved && <TemplatesLink />}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
