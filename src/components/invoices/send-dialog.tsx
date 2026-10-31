"use client";

import { useEffect, useId, useState, useTransition, type FormEvent } from "react";
import {
  resendFromLogAction,
  sendInvoiceAction,
  sendPrefillAction,
} from "@/app/(app)/faktury/actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { splitAddresses } from "@/lib/mail-settings";
import { TEXTS } from "@/lib/texts";
import type { SendPrefill } from "@/server/services/invoice-mail";

const T = TEXTS.invoiceMail.dialog;

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function RecordedMessage({ draft }: { draft: SendPrefill }) {
  const rows = [
    [T.recipients, draft.to.join(", ")],
    [T.copies, draft.cc.join(", ")],
    [T.hiddenCopies, draft.bcc.join(", ")],
    [T.subject, draft.subject],
  ].filter(([, value]) => value !== "");
  return (
    <dl data-testid="resend-summary" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Composer({
  invoiceId,
  logId,
  onClose,
  onSent,
}: {
  invoiceId: string;
  logId?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState<SendPrefill | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let current = true;
    sendPrefillAction({ id: invoiceId, logId }).then(
      (reply) => {
        if (!current) return;
        if (!reply.ok) {
          setError(reply.error);
          return;
        }
        const { draft: prefill } = reply;
        setDraft(prefill);
        setTo(prefill.to.join(", "));
        setCc(prefill.cc.join(", "));
        setBcc(prefill.bcc.join(", "));
        setSubject(prefill.subject);
        setBody(prefill.body);
      },
      () => {
        if (current) setError(T.failed);
      },
    );
    return () => {
      current = false;
    };
  }, [invoiceId, logId]);

  const blocked = !draft || (draft.unknownPending && !confirmed);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || blocked) return;
    const { requestId } = draft;
    setError(null);
    startTransition(async () => {
      try {
        const reply = logId
          ? await resendFromLogAction({ id: logId, requestId, confirmedUnknown: confirmed })
          : await sendInvoiceAction({
              id: invoiceId,
              message: {
                requestId,
                to: splitAddresses(to),
                cc: splitAddresses(cc),
                bcc: splitAddresses(bcc),
                subject,
                body,
                ...(confirmed && { confirmedUnknown: true }),
              },
            });
        if (reply.ok) onSent();
        else setError(reply.error);
      } catch {
        setError(T.failed);
      }
    });
  }

  const hasCopies = Boolean(draft && draft.cc.length + draft.bcc.length > 0);

  return (
    <form onSubmit={submit} className="contents">
      <AlertDialogHeader>
        <AlertDialogTitle>{logId ? T.resendTitle : T.title}</AlertDialogTitle>
        {(!draft || logId) && (
          <AlertDialogDescription>
            {draft ? draft.attachmentName : T.loading}
          </AlertDialogDescription>
        )}
      </AlertDialogHeader>
      {draft && logId && <RecordedMessage draft={draft} />}
      {draft?.log?.reason && (
        <p className="text-sm text-muted-foreground">{T.previousReason(draft.log.reason)}</p>
      )}
      {draft && !logId && (
        <div className="flex flex-col gap-3">
          <Field label={T.to} hint={T.addressHint} value={to} onChange={setTo} />
          <Field
            label={T.cc}
            hint={hasCopies && cc ? T.copiesHint : undefined}
            value={cc}
            onChange={setCc}
          />
          <Field
            label={T.bcc}
            hint={hasCopies && bcc ? T.copiesHint : undefined}
            value={bcc}
            onChange={setBcc}
          />
          <Field label={T.subject} value={subject} onChange={setSubject} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="send-body">{T.body}</Label>
            <Textarea
              id="send-body"
              rows={8}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">{T.attachment}: </span>
            <span data-testid="send-attachment">{draft.attachmentName}</span>
          </p>
        </div>
      )}
      {draft?.paused && (
        <Alert>
          <AlertDescription>{T.paused}</AlertDescription>
        </Alert>
      )}
      {draft?.unknownPending && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
            {T.unknownWarning}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {T.unknownConfirm}
            </label>
          </AlertDescription>
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
        <Button type="submit" disabled={pending || blocked}>
          {T.send}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function SendDialog({
  invoiceId,
  logId,
  open,
  onClose,
  onSent,
}: {
  invoiceId: string;
  logId?: string;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent size="lg" className="max-h-[90dvh] overflow-y-auto">
        <Composer invoiceId={invoiceId} logId={logId} onClose={onClose} onSent={onSent} />
      </AlertDialogContent>
    </AlertDialog>
  );
}
