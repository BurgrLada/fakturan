"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { addPaymentAction, updatePaymentAction } from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { formatMoneyInput, parseMoney } from "@/lib/money";
import { PAYMENT_CHANNELS, type PaymentChannel } from "@/lib/payments";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.payments.dialog;
const P = TEXTS.payments.panel;

export type PaymentView = {
  id: string;
  kind: "payment" | "difference";
  source: "manual" | "notice" | "import";
  paidOn: string;
  amountMinor: number;
  currency: Currency;
  creditedMinor: number;
  method: PaymentChannel;
  note: string;
};

export type PaymentTarget = {
  invoiceId: string;
  revision: number;
  currency: Currency;
  today: string;
  suggestedMinor: number;
};

function positive(text: string): number | null {
  const value = parseMoney(text);
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function Form({
  target,
  payment,
  dirty,
  onClose,
  onDone,
}: {
  target: PaymentTarget;
  payment: PaymentView | null;
  dirty: { current: boolean };
  onClose: () => void;
  onDone: () => void;
}) {
  const key = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [invalid, setInvalid] = useState<"amount" | "credited" | null>(null);
  const [paidOn, setPaidOn] = useState(payment?.paidOn ?? target.today);
  const initialAmount = payment?.amountMinor ?? target.suggestedMinor;
  const [amount, setAmount] = useState(initialAmount > 0 ? formatMoneyInput(initialAmount) : "");
  const [currency, setCurrency] = useState<Currency>(payment?.currency ?? target.currency);
  const [credited, setCredited] = useState(payment ? formatMoneyInput(payment.creditedMinor) : "");
  const [method, setMethod] = useState<PaymentChannel>(payment?.method ?? "transfer");
  const [note, setNote] = useState(payment?.note ?? "");

  const initial = useRef({ paidOn, amount, currency, credited, method, note });
  useEffect(() => {
    const first = initial.current;
    dirty.current =
      paidOn !== first.paidOn ||
      amount !== first.amount ||
      currency !== first.currency ||
      credited !== first.credited ||
      method !== first.method ||
      note !== first.note;
  }, [dirty, paidOn, amount, currency, credited, method, note]);

  const foreign = currency !== target.currency;
  const locked = payment?.source === "notice";

  function reject(field: "amount" | "credited", text: string) {
    setError(text);
    setInvalid(field);
    document.getElementById(`${key}-${field}`)?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const amountMinor = positive(amount);
    if (amountMinor === null) return reject("amount", T.badAmount);
    const creditedMinor = foreign ? positive(credited) : null;
    if (foreign && creditedMinor === null) return reject("credited", T.badCredited);
    setError(null);
    setInvalid(null);
    const body = {
      revision: target.revision,
      paidOn,
      amountMinor,
      currency,
      creditedMinor,
      method,
      note,
    };
    startTransition(async () => {
      try {
        const reply = payment
          ? await updatePaymentAction({ id: payment.id, payment: body })
          : await addPaymentAction({ id: target.invoiceId, payment: body });
        if (reply.ok) {
          dirty.current = false;
          onDone();
        } else {
          setExpired(Boolean(reply.expired));
          setError(reply.expired ? P.expired : reply.stale ? P.stale : reply.error);
        }
      } catch {
        setError(P.failed);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <AlertDialogHeader>
        <AlertDialogTitle>{payment ? T.editTitle : T.addTitle}</AlertDialogTitle>
      </AlertDialogHeader>
      {locked && <p className="text-sm text-muted-foreground">{T.noticeLocked}</p>}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${key}-date`}>{T.paidOn}</Label>
        <Input
          id={`${key}-date`}
          type="date"
          max={target.today}
          value={paidOn}
          onChange={(event) => setPaidOn(event.target.value)}
        />
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${key}-amount`}>{T.amount}</Label>
          <Input
            id={`${key}-amount`}
            inputMode="decimal"
            disabled={locked}
            aria-invalid={invalid === "amount" || undefined}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${key}-currency`}>{T.currency}</Label>
          <NativeSelect
            id={`${key}-currency`}
            disabled={locked}
            value={currency}
            onChange={(event) => setCurrency(event.target.value as Currency)}
          >
            {CURRENCIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {foreign && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${key}-credited`}>{`${T.credited} (${target.currency})`}</Label>
          <Input
            id={`${key}-credited`}
            inputMode="decimal"
            disabled={locked}
            aria-invalid={invalid === "credited" || undefined}
            aria-describedby={`${key}-credited-hint`}
            value={credited}
            onChange={(event) => setCredited(event.target.value)}
          />
          <p id={`${key}-credited-hint`} className="text-xs text-muted-foreground">
            {T.creditedHint(target.currency)}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${key}-method`}>{T.method}</Label>
        <NativeSelect
          id={`${key}-method`}
          value={method}
          onChange={(event) => setMethod(event.target.value as PaymentChannel)}
        >
          {PAYMENT_CHANNELS.map((option) => (
            <option key={option} value={option}>
              {TEXTS.payments.methods[option]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${key}-note`}>{T.note}</Label>
        <Input id={`${key}-note`} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-col items-start gap-1">
            {error}
            {expired && (
              <a className="underline" href="/prihlaseni">
                {P.login}
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
      <AlertDialogFooter>
        <Button
          type="button"
          variant="outline"
          className="max-sm:h-11"
          disabled={pending}
          onClick={onClose}
        >
          {T.back}
        </Button>
        <Button type="submit" className="max-sm:h-11" disabled={pending}>
          {T.save}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function PaymentDialog({
  open,
  target,
  payment,
  onClose,
  onDone,
}: {
  open: boolean;
  target: PaymentTarget;
  payment: PaymentView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const dirty = useRef(false);
  const [discarding, setDiscarding] = useState(false);

  function close() {
    if (dirty.current) setDiscarding(true);
    else onClose();
  }

  function finish() {
    setDiscarding(false);
    onDone();
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <Form target={target} payment={payment} dirty={dirty} onClose={close} onDone={finish} />
        {discarding && (
          <Alert role="alert" data-testid="payment-discard">
            <AlertDescription className="flex flex-col items-start gap-2">
              {T.discardTitle}
              <span className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="max-sm:h-11"
                  onClick={() => {
                    setDiscarding(false);
                    dirty.current = false;
                    onClose();
                  }}
                >
                  {T.discard}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="max-sm:h-11"
                  onClick={() => setDiscarding(false)}
                >
                  {T.keepEditing}
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
