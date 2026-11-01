"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  cancelInvoiceAction,
  createCreditNoteAction,
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
import type { EmailStatus } from "@/lib/mail-send";
import { SaveTemplateDialog, TemplatesLink } from "./save-template-dialog";
import { SendDialog } from "./send-dialog";

const T = TEXTS.invoices.detail;
const TPL = TEXTS.invoices.templates.save;
const M = TEXTS.invoiceMail;

type Reply = { ok: boolean; error?: string };

export type MailPanel = {
  sendable: boolean;
  available: boolean;
  sending: boolean;
  problem: { id: string; status: EmailStatus; reason: string | null } | null;
  offer: string | null;
};

export function InvoiceActions({
  id,
  editable,
  cancellable,
  hasPayments,
  hasCredits,
  creditable,
  copyable,
  restorable,
  markable,
  refreshable,
  mail,
}: {
  id: string;
  editable: boolean;
  cancellable: boolean;
  hasPayments: boolean;
  hasCredits: boolean;
  creditable: boolean;
  copyable: boolean;
  restorable: boolean;
  markable: boolean;
  refreshable: boolean;
  mail: MailPanel;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [naming, setNaming] = useState(false);
  const [sendingFrom, setSendingFrom] = useState<{ logId?: string } | null>(null);
  const hintId = `send-unavailable-${id}`;
  const canSend = mail.available && !mail.sending;

  function sent() {
    setSendingFrom(null);
    if (mail.offer) router.replace(`/faktury/${id}`);
    else router.refresh();
  }

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

  function createCredit() {
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await createCreditNoteAction({ id });
        if (reply.ok) router.push(`/faktury/${reply.id}/upravit`);
        else setMessage({ ok: false, text: reply.error });
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
        {creditable && (
          <Button variant="outline" disabled={pending} onClick={createCredit}>
            {T.createCredit}
          </Button>
        )}
        {copyable && (
          <>
            <Button variant="outline" disabled={pending} onClick={duplicate}>
              {T.duplicate}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setNaming(true)}>
              {TPL.trigger}
            </Button>
          </>
        )}
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
        {cancellable && !hasPayments && !hasCredits && (
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
        {mail.sendable && (
          <Button
            disabled={!canSend}
            aria-describedby={mail.available ? undefined : hintId}
            onClick={() => setSendingFrom({})}
          >
            {T.send}
          </Button>
        )}
        <SendDialog
          invoiceId={id}
          logId={sendingFrom?.logId}
          open={sendingFrom !== null}
          onClose={() => setSendingFrom(null)}
          onSent={sent}
        />
      </div>
      {(hasPayments || hasCredits) && (
        <p data-testid="cancel-blocked" className="text-sm text-muted-foreground">
          {hasPayments ? T.cancelBlocked : T.cancelCredited}
        </p>
      )}
      {mail.sendable && !mail.available && (
        <p id={hintId} data-testid="send-unavailable" className="text-sm text-muted-foreground">
          {M.detail.unavailable}{" "}
          <Link href="/nastaveni/posta" className="underline underline-offset-4">
            {M.detail.settings}
          </Link>
        </p>
      )}
      {mail.sending && (
        <p data-testid="send-progress" role="status" className="text-sm text-muted-foreground">
          {M.detail.sending}
        </p>
      )}
      {mail.offer && mail.sendable && !mail.sending && (
        <Alert role="status" data-testid="send-offer">
          <AlertDescription className="flex flex-col items-start gap-2">
            {mail.offer}
            {mail.available && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canSend}
                onClick={() => setSendingFrom({})}
              >
                {M.detail.offerSend}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {mail.problem && !mail.sending && (
        <Alert variant="destructive" role="status" data-testid="send-problem">
          <AlertDescription className="flex flex-col items-start gap-2">
            {M.detail.problem(M.statuses[mail.problem.status], mail.problem.reason ?? "")}
            {mail.sendable && mail.available && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSendingFrom({ logId: mail.problem?.id })}
              >
                {mail.problem.status === "unknown" ? M.detail.manualSend : M.detail.resend}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
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
