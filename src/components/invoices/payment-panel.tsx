"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  closeDifferenceAction,
  deletePaymentAction,
  markPaidAction,
} from "@/app/(app)/faktury/actions";
import { undoNoticeAction } from "@/app/(app)/platby/actions";
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
import type { InvoiceStatus } from "@/lib/invoice";
import { formatMoney } from "@/lib/money";
import { canTakePayment, isRefund } from "@/lib/payments";
import { amountDue, type Balance } from "@/lib/qr-payload";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { PaymentDialog, type PaymentView } from "./payment-dialog";
import { RefundDialog } from "./refund-dialog";
import { SendDialog } from "./send-dialog";

const T = TEXTS.payments.panel;
const N = TEXTS.bankQueue.paymentPanel;

type Reply = { ok: true } | { ok: false; error: string; stale?: true; expired?: true };
const TOUCH = "max-sm:h-11 max-sm:min-w-11";

export function PaymentPanel({
  invoiceId,
  revision,
  status,
  currency,
  balance,
  today,
  payments,
  advance,
}: {
  invoiceId: string;
  revision: number;
  status: InvoiceStatus;
  currency: Currency;
  balance: Balance;
  today: string;
  payments: PaymentView[];
  advance: { id: string; number: string | null } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [markDate, setMarkDate] = useState(today);
  const [editing, setEditing] = useState<PaymentView | "new" | null>(null);
  const [removing, setRemoving] = useState<PaymentView | null>(null);
  const [returning, setReturning] = useState<PaymentView | null>(null);
  const [closing, setClosing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [expired, setExpired] = useState(false);
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const receipt = useMemo(() => (receiptFor ? { paymentId: receiptFor } : undefined), [receiptFor]);

  const due = amountDue(balance);
  const receivedMinor = payments
    .filter((item) => item.kind === "payment")
    .reduce((sum, item) => sum + item.creditedMinor, 0);

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
        <dd data-testid="payment-paid">{formatMoney(balance.paidMinor, currency)}</dd>
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
          {advance && (
            <span className="block font-normal" data-testid="payment-overpaid-advance">
              {T.overpaidAdvance}{" "}
              <Link href={`/faktury/${advance.id}`} className="underline underline-offset-4">
                {advance.number}
              </Link>
            </span>
          )}
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
              <span className="flex flex-wrap items-center gap-1">
                {isRefund(item) && <Badge variant="outline">{T.refundBadge}</Badge>}
                {item.source === "notice" && (
                  <Badge variant="outline">{TEXTS.payments.sources.notice}</Badge>
                )}
                {item.notificationId && (
                  <Link
                    href={`/platby#avizo-${item.notificationId}`}
                    className={`${TOUCH} inline-flex items-center px-2 text-xs underline`}
                  >
                    {N.open}
                  </Link>
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
                {item.kind === "payment" && !isRefund(item) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    disabled={pending}
                    onClick={() => setReceiptFor(item.id)}
                  >
                    {T.sendReceipt}
                  </Button>
                )}
                {item.notificationId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    disabled={pending}
                    onClick={() => setReturning(item)}
                  >
                    {N.undo}
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
        {canTakePayment(status) && !balance.supersededAt && (
          <Button
            variant="outline"
            className={TOUCH}
            disabled={pending}
            onClick={() => setEditing("new")}
          >
            {T.add}
          </Button>
        )}
        {balance.paidMinor > 0 && (
          <Button
            variant="outline"
            className={TOUCH}
            disabled={pending}
            onClick={() => setRefunding(true)}
          >
            {T.refund}
          </Button>
        )}
        {status === "partially_paid" && !balance.supersededAt && (
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
      <RefundDialog
        open={refunding}
        target={{
          invoiceId,
          revision,
          currency,
          today,
          suggestedMinor: Math.min(Math.max(-due, 0), receivedMinor),
        }}
        onClose={() => setRefunding(false)}
        onDone={() => {
          setRefunding(false);
          router.refresh();
        }}
      />
      {receipt && (
        <SendDialog
          invoiceId={invoiceId}
          receipt={receipt}
          open
          onClose={() => setReceiptFor(null)}
          onSent={() => {
            setReceiptFor(null);
            setMessage({ ok: true, text: T.receiptQueued });
            router.refresh();
          }}
        />
      )}
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
            <AlertDialogTitle>
              {removing && isRefund(removing) ? T.removeRefundTitle : T.removeTitle}
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="remove-payment-body">
              {removing &&
                (isRefund(removing) ? T.removeRefundBody : T.removeBody)(
                  `${formatMoney(Math.abs(removing.amountMinor), removing.currency)} ze dne ${formatCalendarDate(removing.paidOn, "d. M. yyyy")}`,
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
              {removing && isRefund(removing) ? T.removeRefundConfirm : T.removeConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={returning !== null}
        onOpenChange={(open) => {
          if (!open) setReturning(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{N.undoTitle}</AlertDialogTitle>
            <AlertDialogDescription data-testid="undo-notice-body">
              {N.undoBody}
            </AlertDialogDescription>
            <p className="text-sm text-muted-foreground">{TEXTS.bankQueue.undo.sentWarning}</p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.removeBack}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const target = returning;
                setReturning(null);
                if (target?.notificationId) {
                  const noticeId = target.notificationId;
                  perform(() => undoNoticeAction({ id: noticeId }));
                }
              }}
            >
              {N.undoConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
