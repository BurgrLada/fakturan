"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  deleteRecurringAction,
  pauseRecurringAction,
  resumeRecurringAction,
  saveRecurringAction,
} from "@/app/(app)/pravidelne/actions";
import { CustomerPicker } from "@/components/invoices/customer-picker";
import { LineEditor } from "@/components/invoices/line-editor";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CURRENCIES, type Currency } from "@/lib/currency";
import {
  changeCurrency,
  computeFormTotals,
  formFromDocument,
  nonEmptyLines,
  toDocumentFields,
  type AccountChoice,
  type FormValues,
} from "@/lib/invoice-form";
import type { TemplateDocument } from "@/lib/invoice-template";
import {
  ISSUE_RULES,
  RECURRENCE_FREQUENCIES,
  RECURRING_MODES,
  type IssueRule,
  type RecurrenceFrequency,
  type RecurringMode,
  type RecurringStatus,
} from "@/lib/recurrence";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { useRouteShown } from "@/lib/use-route-shown";
import type { RecurringInput } from "@/server/services/recurring";
import { SchedulePreview, useSchedulePreview } from "./schedule-preview";
import { useVariableTarget, VariablePicker } from "./variable-picker";

const T = TEXTS.recurring;
const F = T.fields;
const INVOICE = TEXTS.invoices.form;

export type RecurringFormInitial = {
  name: string;
  customerId: string | null;
  customerName: string;
  document: TemplateDocument;
  frequency: RecurrenceFrequency;
  every: number;
  issueRule: IssueRule;
  issueDay: number | null;
  startsOn: string;
  endsOn: string | null;
  maxCount: number | null;
  periodOffset: number;
  mode: RecurringMode;
  notifyDaysBefore: number | null;
  sendConfirmed: boolean;
};

export type RecurringFormProps = {
  planId: string | null;
  status: RecurringStatus | null;
  initial: RecurringFormInitial;
  accounts: (AccountChoice & { name: string })[];
  units: string[];
  defaultUnit: string;
  recurringSend: boolean;
};

const EVERY_FREQUENCIES: readonly RecurrenceFrequency[] = ["every_weeks", "every_months"];
const WEEK_FREQUENCIES: readonly RecurrenceFrequency[] = ["weekly", "every_weeks"];

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function formValuesOf(document: TemplateDocument, defaultUnit: string): FormValues {
  return formFromDocument(
    {
      ...document,
      customerId: null,
      seriesId: null,
      issueDate: null,
      dueDate: null,
      taxableDate: null,
      exchangeRateMicros: null,
      discountValue: document.discountValue,
    },
    defaultUnit,
  );
}

const optionalNumber = (text: string): number | null => (text.trim() === "" ? null : Number(text));

export function RecurringForm(props: RecurringFormProps) {
  const { planId, initial, accounts, units, defaultUnit, recurringSend } = props;
  const router = useRouter();
  const { shown, root } = useRouteShown<HTMLFormElement>();
  const variables = useVariableTarget();

  const [status, setStatus] = useState(props.status);
  const [name, setName] = useState(initial.name);
  const [customerId, setCustomerId] = useState(initial.customerId);
  const [customerName, setCustomerName] = useState(initial.customerName);
  const [values, setValues] = useState(() => formValuesOf(initial.document, defaultUnit));
  const [dueDays, setDueDays] = useState(String(initial.document.dueDays));
  const [frequency, setFrequency] = useState(initial.frequency);
  const [every, setEvery] = useState(String(initial.every));
  const [issueRule, setIssueRule] = useState(initial.issueRule);
  const [issueDay, setIssueDay] = useState(
    initial.issueDay === null ? "" : String(initial.issueDay),
  );
  const [startsOn, setStartsOn] = useState(initial.startsOn);
  const [endsOn, setEndsOn] = useState(initial.endsOn ?? "");
  const [maxCount, setMaxCount] = useState(
    initial.maxCount === null ? "" : String(initial.maxCount),
  );
  const [periodOffset, setPeriodOffset] = useState(String(initial.periodOffset));
  const [mode, setMode] = useState(initial.mode);
  const [notify, setNotify] = useState(
    initial.notifyDaysBefore === null ? "" : String(initial.notifyDaysBefore),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [offerReactivate, setOfferReactivate] = useState(false);

  const fields = useMemo(() => toDocumentFields(values), [values]);
  const invalid = useMemo(() => new Set(fields.ok ? [] : fields.invalid), [fields]);
  const totals = useMemo(() => computeFormTotals(values), [values]);
  const nets = useMemo(() => {
    const kept = nonEmptyLines(values.lines);
    return new Map(kept.map((line, i) => [line.key, totals?.lines[i]?.netMinor ?? 0]));
  }, [values.lines, totals]);

  const hasEvery = EVERY_FREQUENCIES.includes(frequency);
  const weekBased = WEEK_FREQUENCIES.includes(frequency);

  const payload = useMemo<RecurringInput | null>(() => {
    if (!fields.ok || !startsOn) return null;
    const numbers = {
      dueDays: Number(dueDays),
      every: hasEvery ? Number(every) : 1,
      issueDay: issueRule === "day" ? Number(issueDay) : null,
      maxCount: optionalNumber(maxCount),
      periodOffset: Number(periodOffset),
      notifyDaysBefore: optionalNumber(notify),
    };
    if (Object.values(numbers).some((value) => value !== null && Number.isNaN(value))) return null;
    if (issueRule === "day" && issueDay.trim() === "") return null;
    const f = fields.fields;
    return {
      ...(planId && { id: planId }),
      name,
      customerId,
      document: {
        type: initial.document.type,
        bankAccountId: f.bankAccountId,
        dueDays: numbers.dueDays,
        language: f.language,
        currency: f.currency,
        paymentMethod: f.paymentMethod,
        orderRef: f.orderRef,
        reference: f.reference,
        textBefore: f.textBefore,
        textAfter: f.textAfter,
        note: f.note,
        discountKind: f.discountKind,
        discountValue: f.discountValue,
        rounding: f.rounding,
        appearance: f.appearance,
        lines: f.lines,
      },
      frequency,
      every: numbers.every,
      issueRule,
      issueDay: numbers.issueDay,
      startsOn,
      endsOn: endsOn || null,
      maxCount: numbers.maxCount,
      periodOffset: numbers.periodOffset,
      mode,
      notifyDaysBefore: numbers.notifyDaysBefore,
    } satisfies RecurringInput;
  }, [
    fields,
    startsOn,
    dueDays,
    hasEvery,
    every,
    issueRule,
    issueDay,
    maxCount,
    periodOffset,
    notify,
    planId,
    name,
    customerId,
    initial.document.type,
    frequency,
    endsOn,
    mode,
  ]);

  // A plan without a name still has dates worth showing.
  const preview = useSchedulePreview(
    useMemo(
      () => (payload ? { ...payload, name: name.trim() ? name : "-" } : null),
      [payload, name],
    ),
  );
  const nextDate = preview.kind === "ready" ? (preview.rows[0]?.issueDate ?? null) : null;

  const impacts = [
    ...(planId && startsOn !== initial.startsOn ? [T.changedStartsOn] : []),
    ...(planId && (optionalNumber(maxCount) ?? null) !== initial.maxCount
      ? [T.changedMaxCount]
      : []),
  ];

  const needsConfirmation =
    mode === "send" &&
    !(initial.mode === "send" && initial.sendConfirmed && initial.customerId === customerId);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  async function save(confirmSend: boolean) {
    if (!payload) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const reply = await saveRecurringAction(confirmSend ? { ...payload, confirmSend } : payload);
      if (!reply.ok) {
        setError(reply.error);
        return;
      }
      if (!planId) {
        router.push(`/pravidelne/${reply.id}`);
        return;
      }
      setMessage(T.actions.saved);
      setOfferReactivate(status === "finished");
      router.refresh();
    } catch {
      setError(T.actions.failed);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError(T.validation.name);
      return;
    }
    if (!payload) {
      setError(T.validation.invalid);
      return;
    }
    if (needsConfirmation) setConfirming(true);
    else void save(false);
  }

  async function change(
    action: (raw: unknown) => Promise<{ ok: true } | { ok: false; error: string }>,
    next: RecurringStatus | null,
  ) {
    if (!planId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const reply = await action({ id: planId });
      if (!reply.ok) {
        setError(reply.error);
        return;
      }
      if (next) setStatus(next);
      setOfferReactivate(false);
      router.refresh();
    } catch {
      setError(T.actions.failed);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setDeleting(false);
    if (!planId) return;
    setBusy(true);
    try {
      const reply = await deleteRecurringAction({ id: planId });
      if (reply.ok) router.push("/pravidelne");
      else setError(reply.error);
    } catch {
      setError(T.actions.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!shown) return null;

  return (
    <form ref={root} onSubmit={submit} className="flex flex-col gap-8" noValidate>
      {planId && (
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="plan-status" className="text-sm">
            {status ? T.statuses[status] : ""}
          </span>
          {status === "active" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => change(pauseRecurringAction, "paused")}
            >
              {T.actions.pause}
            </Button>
          )}
          {status === "paused" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => change(resumeRecurringAction, "active")}
            >
              {T.actions.resume}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setDeleting(true)}
          >
            {T.actions.delete}
          </Button>
        </div>
      )}

      {offerReactivate && status === "finished" && preview.kind === "ready" && nextDate && (
        <Alert role="status" data-testid="reactivate-offer">
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{T.actions.reactivateOffer}</span>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => change(resumeRecurringAction, "active")}
            >
              {T.actions.reactivate}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <section className="flex flex-col gap-4">
        <Field id="field-name" label={F.name}>
          <Input id="field-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <CustomerPicker
          name={customerName}
          onNameChange={(next) => {
            setCustomerName(next);
            setCustomerId(null);
          }}
          onPick={(picked) => {
            setCustomerId(picked.id);
            setCustomerName(picked.name);
          }}
          onExpired={() => router.refresh()}
        />
      </section>

      <div className="flex flex-col gap-8" onFocusCapture={variables.onFocusCapture}>
        <section className="flex flex-col gap-4">
          <h2 className="text-lg">{F.lines}</h2>
          <LineEditor
            lines={values.lines}
            currency={values.currency}
            nets={nets}
            units={units}
            defaultUnit={defaultUnit}
            invalid={invalid}
            onChange={(update) =>
              setValues((current) => ({ ...current, lines: update(current.lines) }))
            }
            onExpired={() => router.refresh()}
          />
        </section>

        <section className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="field-textBefore" label={F.textBefore}>
              <Textarea
                id="field-textBefore"
                value={values.textBefore}
                onChange={(event) => set("textBefore", event.target.value)}
              />
            </Field>
            <Field id="field-textAfter" label={F.textAfter}>
              <Textarea
                id="field-textAfter"
                value={values.textAfter}
                onChange={(event) => set("textAfter", event.target.value)}
              />
            </Field>
            <Field id="field-note" label={F.note}>
              <Textarea
                id="field-note"
                value={values.note}
                onChange={(event) => set("note", event.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-4">
              <Field id="field-reference" label={F.reference}>
                <Input
                  id="field-reference"
                  value={values.reference}
                  onChange={(event) => set("reference", event.target.value)}
                />
              </Field>
              <Field id="field-orderRef" label={F.orderRef}>
                <Input
                  id="field-orderRef"
                  value={values.orderRef}
                  onChange={(event) => set("orderRef", event.target.value)}
                />
              </Field>
            </div>
          </div>
        </section>
      </div>

      <VariablePicker onInsert={variables.insert} message={variables.message} />

      <section className="grid gap-4 sm:grid-cols-3">
        <Field id="field-currency" label={F.currency}>
          <NativeSelect
            id="field-currency"
            value={values.currency}
            onChange={(event) =>
              setValues((current) =>
                changeCurrency(current, event.target.value as Currency, new Set(), accounts),
              )
            }
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="field-bankAccountId" label={TEXTS.invoices.form.fields.bankAccount}>
          <NativeSelect
            id="field-bankAccountId"
            value={values.bankAccountId ?? ""}
            onChange={(event) => set("bankAccountId", event.target.value || null)}
          >
            <option value="">{INVOICE.noAccount}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currency})
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="field-dueDays" label={F.dueDays}>
          <Input
            id="field-dueDays"
            type="number"
            min={0}
            value={dueDays}
            onChange={(event) => setDueDays(event.target.value)}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="field-frequency" label={F.frequency}>
            <NativeSelect
              id="field-frequency"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as RecurrenceFrequency)}
            >
              {RECURRENCE_FREQUENCIES.map((option) => (
                <option key={option} value={option}>
                  {T.frequencies[option]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {hasEvery && (
            <Field
              id="field-every"
              label={`${F.every} (${T.everyUnit[frequency as "every_weeks"]})`}
            >
              <Input
                id="field-every"
                type="number"
                min={1}
                value={every}
                onChange={(event) => setEvery(event.target.value)}
              />
            </Field>
          )}
          <Field id="field-issueRule" label={F.issueRule}>
            <NativeSelect
              id="field-issueRule"
              value={issueRule}
              onChange={(event) => setIssueRule(event.target.value as IssueRule)}
            >
              {ISSUE_RULES.map((option) => (
                <option key={option} value={option}>
                  {T.issueRules[option]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {issueRule === "day" && (
            <Field
              id="field-issueDay"
              label={F.issueDay}
              hint={weekBased ? T.issueDayWeek : T.issueDayMonth}
            >
              <Input
                id="field-issueDay"
                type="number"
                min={1}
                max={weekBased ? 7 : 31}
                aria-describedby="field-issueDay-hint"
                value={issueDay}
                onChange={(event) => setIssueDay(event.target.value)}
              />
            </Field>
          )}
          <Field id="field-startsOn" label={F.startsOn}>
            <Input
              id="field-startsOn"
              type="date"
              aria-describedby="field-startsOn-hint"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </Field>
          <Field id="field-endsOn" label={F.endsOn}>
            <Input
              id="field-endsOn"
              type="date"
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          </Field>
          <Field id="field-maxCount" label={F.maxCount}>
            <Input
              id="field-maxCount"
              type="number"
              min={1}
              aria-describedby="field-maxCount-hint"
              value={maxCount}
              onChange={(event) => setMaxCount(event.target.value)}
            />
          </Field>
          <Field id="field-periodOffset" label={F.periodOffset}>
            <Input
              id="field-periodOffset"
              type="number"
              min={-12}
              max={12}
              aria-describedby="field-periodOffset-hint"
              value={periodOffset}
              onChange={(event) => setPeriodOffset(event.target.value)}
            />
          </Field>
        </div>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          <li id="field-startsOn-hint">{T.startsOnHint}</li>
          <li id="field-maxCount-hint">{T.maxCountHint}</li>
          <li id="field-periodOffset-hint">{T.periodOffsetHint}</li>
        </ul>
        {impacts.length > 0 && (
          <Alert role="status" data-testid="change-impact">
            <AlertDescription>
              {T.changeImpact(
                impacts.join(" "),
                nextDate ? formatCalendarDate(nextDate, "d. M. yyyy") : null,
              )}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <SchedulePreview state={preview} />

      <fieldset className="flex flex-col gap-3">
        <legend className="text-lg">{F.mode}</legend>
        {RECURRING_MODES.map((option) => {
          const disabled = option === "send" && !recurringSend && mode !== "send";
          return (
            <div key={option} className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  value={option}
                  checked={mode === option}
                  disabled={disabled}
                  onChange={() => setMode(option)}
                />
                {T.modes[option]}
              </label>
              <p className="pl-6 text-sm text-muted-foreground">
                {T.modeHints[option]}
                {option === "send" && !recurringSend && (
                  <>
                    {" "}
                    {T.sendNeedsAutomation}{" "}
                    <Link href="/nastaveni/automatizace" className="underline underline-offset-4">
                      {T.sendNeedsAutomationLink}
                    </Link>
                    .
                  </>
                )}
              </p>
            </div>
          );
        })}
        <div className="sm:max-w-xs">
          <Field id="field-notify" label={F.notifyDaysBefore} hint={T.notifyHint}>
            <Input
              id="field-notify"
              type="number"
              min={1}
              max={30}
              aria-describedby="field-notify-hint"
              value={notify}
              onChange={(event) => setNotify(event.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? T.actions.saving : T.actions.save}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.confirmSend.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {T.confirmSend.body(customerName.trim() || T.confirmSend.noCustomer)}{" "}
              {T.confirmSend.what}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.confirmSend.back}</AlertDialogCancel>
            <Button
              onClick={() => {
                setConfirming(false);
                void save(true);
              }}
            >
              {T.confirmSend.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.actions.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{T.actions.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.actions.deleteBack}</AlertDialogCancel>
            <Button variant="destructive" onClick={remove}>
              {T.actions.deleteConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
