"use client";

import { useEffect, useId, useState, useTransition, type FormEvent } from "react";
import {
  receiptPrefillAction,
  reminderPrefillAction,
  resendFromLogAction,
  sendInvoiceAction,
  sendPrefillAction,
  sendReceiptAction,
  sendReminderAction,
} from "@/app/(app)/faktury/actions";
import { GoToLink } from "@/components/go-to-link";
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
const E = TEXTS.invoiceMail.errors;
const R = TEXTS.reminders;

export type ReminderChoice = { stageKey: string | null };
export type ReceiptChoice = { paymentId: string };

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
    [T.body, draft.body],
  ].filter(([, value]) => value !== "");
  return (
    <dl data-testid="resend-summary" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words whitespace-pre-line">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Composer({
  invoiceId,
  logId,
  reminder,
  receipt,
  onClose,
  onSent,
}: {
  invoiceId: string;
  logId?: string;
  reminder?: ReminderChoice;
  receipt?: ReceiptChoice;
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
  const [repeatConfirmed, setRepeatConfirmed] = useState(false);
  const [attachIsdoc, setAttachIsdoc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let current = true;
    const prefill = reminder
      ? reminderPrefillAction({ id: invoiceId, stageKey: reminder.stageKey })
      : receipt
        ? receiptPrefillAction({ id: invoiceId, paymentId: receipt.paymentId })
        : sendPrefillAction({ id: invoiceId, logId });
    prefill.then(
      (reply) => {
        if (!current) return;
        if (!reply.ok) {
          setError(reply.error);
          return;
        }
        const { draft: loaded } = reply;
        setDraft(loaded);
        setTo(loaded.to.join(", "));
        setCc(loaded.cc.join(", "));
        setBcc(loaded.bcc.join(", "));
        setSubject(loaded.subject);
        setBody(loaded.body);
        setAttachIsdoc(loaded.attachIsdoc);
      },
      () => {
        if (current) setError(T.failed);
      },
    );
    return () => {
      current = false;
    };
  }, [invoiceId, logId, reminder, receipt]);

  const blocked =
    !draft || (draft.unknownPending && !confirmed) || (draft.repeat === true && !repeatConfirmed);
  const recorded = Boolean(logId && draft?.log?.current);
  const offersIsdoc = Boolean(draft?.isdocAvailable && !reminder && !receipt);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || blocked) return;
    const { requestId, revision } = draft;
    setError(null);
    startTransition(async () => {
      try {
        const message = {
          requestId,
          revision,
          ...(logId && { logId }),
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          bcc: splitAddresses(bcc),
          subject,
          body,
          ...(confirmed && { confirmedUnknown: true }),
          ...(offersIsdoc && attachIsdoc && { attachIsdoc: true }),
        };
        const paymentId = receipt?.paymentId ?? draft.log?.paymentId;
        const reply = reminder
          ? await sendReminderAction({
              id: invoiceId,
              stageKey: reminder.stageKey,
              confirmedRepeat: repeatConfirmed,
              message,
            })
          : recorded
            ? await resendFromLogAction({ id: logId, requestId, confirmedUnknown: confirmed })
            : paymentId
              ? await sendReceiptAction({ id: invoiceId, paymentId, message })
              : await sendInvoiceAction({ id: invoiceId, message });
        if (reply.ok) onSent();
        else if (reply.error === E.unknownPending) {
          setDraft({ ...draft, unknownPending: true });
        } else if (reply.error === R.errors.confirmRepeat) {
          setDraft({ ...draft, repeat: true });
        } else setError(reply.error);
      } catch {
        setError(T.failed);
      }
    });
  }

  const hasCopies = Boolean(draft && draft.cc.length + draft.bcc.length > 0);

  return (
    <form onSubmit={submit} className="contents">
      <AlertDialogHeader>
        <AlertDialogTitle>
          {reminder ? R.dialog.title : receipt ? T.receiptTitle : logId ? T.resendTitle : T.title}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {draft ? (recorded ? draft.attachmentName : T.review) : error ? T.loadFailed : T.loading}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {draft && recorded && <RecordedMessage draft={draft} />}
      {draft && logId && !recorded && <p className="text-sm">{T.rebuilt}</p>}
      {draft?.log?.reason && (
        <p className="text-sm text-muted-foreground">{T.previousReason(draft.log.reason)}</p>
      )}
      {draft && !recorded && (
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
          {offersIsdoc && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={attachIsdoc}
                onChange={(event) => setAttachIsdoc(event.target.checked)}
              />
              <span className="flex flex-col">
                {T.attachIsdoc}
                <span className="text-muted-foreground">{T.attachIsdocHint}</span>
              </span>
            </label>
          )}
        </div>
      )}
      {draft?.paused && (
        <Alert>
          <AlertDescription>
            {T.paused} <GoToLink href="/nastaveni/automatizace">{TEXTS.goTo.automation}</GoToLink>
          </AlertDescription>
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
      {draft?.repeat && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
            {R.dialog.repeatWarning}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={repeatConfirmed}
                onChange={(event) => setRepeatConfirmed(event.target.checked)}
              />
              {R.dialog.repeatConfirm}
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
  reminder,
  receipt,
  open,
  onClose,
  onSent,
}: {
  invoiceId: string;
  logId?: string;
  reminder?: ReminderChoice;
  receipt?: ReceiptChoice;
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
        <Composer
          invoiceId={invoiceId}
          logId={logId}
          reminder={reminder}
          receipt={receipt}
          onClose={onClose}
          onSent={onSent}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}
