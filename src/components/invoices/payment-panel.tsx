"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  closeDifferenceAction,
  deletePaymentAction,
  markPaidAction,
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Currency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { amountDue } from "@/lib/qr-payload";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { PaymentDialog, type PaymentView } from "./payment-dialog";

const T = TEXTS.payments.panel;

type Reply = { ok: true } | { ok: false; error: string; stale?: true; expired?: true };
const TOUCH = "max-sm:h-11 max-sm:min-w-11";

export function PaymentPanel({
  invoiceId,
  revision,
  status,
  currency,
  totalMinor,
  paidMinor,
  today,
  payments,
}: {
  invoiceId: string;
  revision: number;
  status: string;
  currency: Currency;
  totalMinor: number;
  paidMinor: number;
  today: string;
  payments: PaymentView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [markDate, setMarkDate] = useState(today);
  const [editing, setEditing] = useState<PaymentView | "new" | null>(null);
  const [removing, setRemoving] = useState<PaymentView | null>(null);
  const [closing, setClosing] = useState(false);
  const [expired, setExpired] = useState(false);

  const due = amountDue({ totalMinor, paidMinor });

  function perform(work: () => Promise<Reply>, done?: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await work();
        if (reply.ok) {
          if (done) setMessage({ ok: true, text: done });
          router.refresh();
        } else {
          if (reply.expired) setExpired(true);
          setMessage({
            ok: false,
            text: reply.expired ? T.expired : reply.stale ? T.stale : reply.error,
          });
        }
      } catch {
        setMessage({ ok: false, text: T.failed });
      }
    });
  }

  return (
    <section className="flex flex-col gap-3 sm:max-w-xl" data-testid="payment-panel">
      <h2 className="text-lg">{T.title}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{T.paid}</dt>
        <dd data-testid="payment-paid">{formatMoney(paidMinor, currency)}</dd>
        {due > 0 && (
          <>
            <dt className="text-muted-foreground">{T.left}</dt>
            <dd data-testid="payment-left">{formatMoney(due, currency)}</dd>
          </>
        )}
      </dl>
      {due < 0 && (
        <p
          data-testid="payment-overpaid"
          data-tone="warning"
          role="status"
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
        >
          {T.overpaid(formatMoney(-due, currency))}
        </p>
      )}
      {payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.empty}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {payments.map((item) => (
            <li
              key={item.id}
              data-testid="payment-row"
              className="flex flex-wrap items-center justify-between gap-2 p-2"
            >
              <span className="flex flex-col">
                <span>
                  {formatCalendarDate(item.paidOn, "d. M. yyyy")}
                  {" · "}
                  {formatMoney(item.amountMinor, item.currency)}
                  {item.currency !== currency && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({T.credited(formatMoney(item.creditedMinor, currency))})
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.kind === "difference" ? T.difference : TEXTS.payments.methods[item.method]}
                  {item.note && ` · ${item.note}`}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {item.source === "notice" && (
                  <Badge variant="outline">{TEXTS.payments.sources.notice}</Badge>
                )}
                {item.kind === "payment" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    disabled={pending}
                    onClick={() => setEditing(item)}
                  >
                    {T.edit}
                  </Button>
                )}
                {item.source !== "notice" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    disabled={pending}
                    onClick={() => setRemoving(item)}
                  >
                    {T.remove}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {due > 0 && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="mark-paid-date">{T.markDate}</Label>
              <Input
                id="mark-paid-date"
                type="date"
                max={today}
                className="max-sm:h-11"
                value={markDate}
                onChange={(event) => setMarkDate(event.target.value)}
              />
            </div>
            <Button
              className={TOUCH}
              disabled={pending || !markDate}
              onClick={() =>
                perform(
                  () => markPaidAction({ id: invoiceId, revision, paidOn: markDate }),
                  T.marked,
                )
              }
            >
              {T.markPaid}
            </Button>
          </>
        )}
        <Button
          variant="outline"
          className={TOUCH}
          disabled={pending}
          onClick={() => setEditing("new")}
        >
          {T.add}
        </Button>
        {status === "partially_paid" && (
          <Button
            variant="outline"
            className={TOUCH}
            disabled={pending}
            onClick={() => setClosing(true)}
          >
            {T.closeAction}
          </Button>
        )}
      </div>
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription className="flex flex-col items-start gap-1">
            {message.text}
            {expired && (
              <a className="underline" href="/prihlaseni">
                {T.login}
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
      <PaymentDialog
        open={editing !== null}
        target={{
          invoiceId,
          revision,
          currency,
          today,
          suggestedMinor: Math.max(due, 0),
        }}
        payment={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          router.refresh();
        }}
      />
      <AlertDialog open={closing} onOpenChange={setClosing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.closeTitle}</AlertDialogTitle>
            <AlertDialogDescription data-testid="close-difference-body">
              {T.closeBody(formatMoney(Math.max(due, 0), currency))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.closeBack}</AlertDialogCancel>
            <Button
              onClick={() => {
                setClosing(false);
                perform(() => closeDifferenceAction({ id: invoiceId, revision, confirmed: true }));
              }}
            >
              {T.closeConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription data-testid="remove-payment-body">
              {removing &&
                T.removeBody(
                  `${formatMoney(removing.amountMinor, removing.currency)} ze dne ${formatCalendarDate(removing.paidOn, "d. M. yyyy")}`,
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.removeBack}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) perform(() => deletePaymentAction({ id: target.id, revision }));
              }}
            >
              {T.removeConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
