"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  customerDefaultsAction,
  issueAction,
  issuePreviewAction,
  saveDraftAction,
  updateIssuedAction,
} from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { DraftSaver, type SaveStatus } from "@/lib/draft-saver";
import {
  applyCustomerDefaults,
  changeCurrency,
  changeIssueDate,
  computeFormTotals,
  fieldTarget,
  newClientId,
  nonEmptyLines,
  toDocumentFields,
  type AccountChoice,
  type DocumentFields,
  type FormValues,
  type TouchedField,
} from "@/lib/invoice-form";
import { DISCOUNT_KINDS, ROUNDING_MODES } from "@/lib/invoice-totals";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, PAYMENT_METHODS } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { useRouteShown } from "@/lib/use-route-shown";
import { CustomerPicker } from "./customer-picker";
import { IssueDialog, type IssueSummary } from "./issue-dialog";
import { LineEditor } from "./line-editor";
import { PdfPreview } from "./pdf-preview";
import { TagInput } from "./tag-input";

const T = TEXTS.invoices.form;
const F = T.fields;
const P = TEXTS.preferences;

type Problem = { field: string; message: string };
type Saved = { id: string; revision: number; problems: Problem[] };
type Payload = { draft: Record<string, unknown>; tags: string[] };

export type InvoiceFormProps = {
  id: string | null;
  mode: "draft" | "issued";
  status: string;
  number: string;
  revision: number;
  customerName: string;
  initial: FormValues;
  initialTags: string[];
  initialProblems: Problem[];
  accounts: (AccountChoice & { name: string })[];
  series: { id: string; name: string }[];
  units: string[];
  tagOptions: string[];
  defaultUnit: string;
};

function draftOf(values: FormValues, fields: DocumentFields): Record<string, unknown> {
  return {
    ...fields,
    type: "invoice",
    customerId: values.customerId,
    seriesId: values.seriesId,
  };
}

function payloadOf(values: FormValues, tags: string[]): Payload | null {
  const result = toDocumentFields(values);
  return result.ok ? { draft: draftOf(values, result.fields), tags } : null;
}

const keyOf = (payload: Payload | null) => JSON.stringify(payload);

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function statusText(status: SaveStatus, hasId: boolean): string {
  if (status.kind === "error") return status.message;
  if (status.kind === "idle") return hasId ? T.status.idleSaved : T.status.idle;
  if (status.kind === "stale") return "";
  return T.status[status.kind];
}

function Form(props: InvoiceFormProps) {
  const { mode, accounts, series, units, tagOptions, defaultUnit } = props;
  const router = useRouter();
  const [values, setValues] = useState(props.initial);
  const [tags, setTags] = useState(props.initialTags);
  const [number, setNumber] = useState(props.number);
  const [customerName, setCustomerName] = useState(props.customerName);
  const [savedId, setSavedId] = useState(props.id);
  const [revision, setRevision] = useState(props.revision);
  const [problems, setProblems] = useState(props.initialProblems);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<IssueSummary | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const shown = useRouteShown();

  const touched = useRef(new Set<TouchedField>());
  const identity = useRef({ id: props.id, revision: props.revision, clientId: "" });
  const problemsRef = useRef<HTMLDivElement>(null);

  const [saver] = useState(
    () =>
      new DraftSaver<Payload, Saved>({
        baseline: keyOf(payloadOf(props.initial, props.initialTags)),
        send: async ({ draft, tags: names }) => {
          const { id, revision: current } = identity.current;
          if (!id) identity.current.clientId ||= newClientId();
          const reference = id
            ? { id, revision: current }
            : { clientId: identity.current.clientId };
          const result = await saveDraftAction({ draft: { ...draft, ...reference }, tags: names });
          if (result.ok) return { kind: "saved", result };
          if (result.stale) return { kind: "stale" };
          return { kind: "rejected", error: result.error };
        },
        onSaved: (saved) => {
          const created = !identity.current.id;
          identity.current.id = saved.id;
          identity.current.revision = saved.revision;
          setSavedId(saved.id);
          setRevision(saved.revision);
          setProblems(saved.problems);
          // Keeps the same form instance, so typing carries on while a reload finds the draft.
          if (created) window.history.replaceState(null, "", `/faktury/${saved.id}/upravit`);
        },
        onStatus: (next) => {
          setStatus(next);
          if (next.kind === "stale") setLocked(true);
        },
      }),
  );

  const result = useMemo(() => toDocumentFields(values), [values]);
  const invalid = useMemo(() => new Set(result.ok ? [] : result.invalid), [result]);
  const totals = useMemo(() => computeFormTotals(values), [values]);
  const nets = useMemo(() => {
    const kept = nonEmptyLines(values.lines);
    return new Map(kept.map((line, i) => [line.key, totals?.lines[i]?.netMinor ?? 0]));
  }, [values.lines, totals]);

  useEffect(() => {
    if (mode !== "draft" || !result.ok) return;
    const payload = { draft: draftOf(values, result.fields), tags };
    saver.change(keyOf(payload), payload);
  }, [mode, saver, values, tags, result]);

  useEffect(() => {
    if (mode !== "draft") return;
    const warn = (event: BeforeUnloadEvent) => {
      if (saver.isDirty()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      void saver.flush();
    };
  }, [mode, saver]);

  function set<K extends TouchedField>(field: K, value: FormValues[K]) {
    touched.current.add(field);
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function pickCustomer(customer: { id: string; name: string }) {
    setCustomerName(customer.name);
    setValues((current) => ({ ...current, customerId: customer.id }));
    try {
      const reply = await customerDefaultsAction({ customerId: customer.id });
      if (!reply.ok) {
        setMessage({ ok: false, text: reply.error });
        return;
      }
      setValues((current) =>
        applyCustomerDefaults(current, reply.defaults, touched.current, accounts),
      );
    } catch {
      setMessage({ ok: false, text: T.network });
    }
  }

  function focusFirstInvalid() {
    const first = result.ok ? null : result.invalid[0];
    if (first) document.getElementById(first)?.focus();
  }

  async function startIssue() {
    setMessage(null);
    if (!result.ok) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      if (!(await saver.flush())) return;
      const { id } = identity.current;
      if (!id) {
        setMessage({ ok: false, text: T.emptyDraft });
        return;
      }
      const preview = await issuePreviewAction({ id });
      if (!preview.ok) {
        setMessage({ ok: false, text: preview.error });
        return;
      }
      if (preview.problems.length > 0) {
        setProblems(preview.problems);
        problemsRef.current?.focus();
        return;
      }
      setDialogError(null);
      setSummary(preview);
    } catch {
      setMessage({ ok: false, text: T.network });
    } finally {
      setBusy(false);
    }
  }

  async function reloadPreview() {
    const preview = await issuePreviewAction({ id: identity.current.id });
    if (preview.ok) setSummary(preview);
    else setDialogError(preview.error);
  }

  async function applyToday() {
    if (!summary) return;
    const next = changeIssueDate(values, summary.today, touched.current);
    touched.current.add("issueDate");
    setValues(next);
    const payload = payloadOf(next, tags);
    if (!payload) return;
    setBusy(true);
    try {
      saver.change(keyOf(payload), payload);
      if (await saver.flush()) await reloadPreview();
    } catch {
      setDialogError(T.network);
    } finally {
      setBusy(false);
    }
  }

  async function confirmIssue(variableSymbol: string | undefined) {
    const { id, revision: current } = identity.current;
    setBusy(true);
    setDialogError(null);
    try {
      const issued = await issueAction({ id, revision: current, variableSymbol });
      if (issued.ok) {
        router.push(`/faktury/${issued.id}`);
        return;
      }
      if (issued.stale) {
        setSummary(null);
        setLocked(true);
        return;
      }
      if (issued.problems) {
        setProblems(issued.problems);
        setSummary(null);
        problemsRef.current?.focus();
        return;
      }
      setDialogError(issued.error);
    } catch {
      setDialogError(T.network);
    } finally {
      setBusy(false);
    }
  }

  async function saveIssued() {
    setMessage(null);
    setNotices([]);
    if (!result.ok) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      const reply = await updateIssuedAction({
        id: identity.current.id,
        tags,
        document: { ...result.fields, number, revision: identity.current.revision },
      });
      if (!reply.ok) {
        if (reply.stale) setLocked(true);
        else setMessage({ ok: false, text: reply.error });
        return;
      }
      identity.current.revision = reply.revision;
      setRevision(reply.revision);
      setMessage({ ok: true, text: T.saved });
      setNotices([
        ...(reply.resendSuggested ? [T.resend] : []),
        ...(reply.balanceWarning === "overpaid" ? [T.overpaid] : []),
        ...(reply.balanceWarning === "underpaid" ? [T.underpaid] : []),
      ]);
    } catch {
      setMessage({ ok: false, text: T.network });
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "draft") void startIssue();
    else void saveIssued();
  }

  const showRate = values.currency !== "CZK";

  if (!shown) return null;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
        {locked && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="flex flex-col items-start gap-2">
              {TEXTS.invoices.stale}
              <a className="underline" href={`/faktury/${savedId}/upravit`}>
                {T.refresh}
              </a>
            </AlertDescription>
          </Alert>
        )}
        {mode === "issued" && props.status === "sent" && (
          <Alert role="status">
            <AlertDescription>{T.sentWarning}</AlertDescription>
          </Alert>
        )}
        {mode === "draft" && !locked && (
          <p
            role="status"
            data-testid="save-status"
            className={`text-sm ${status.kind === "error" || status.kind === "offline" || !result.ok ? "text-destructive" : "text-muted-foreground"}`}
          >
            {result.ok ? statusText(status, savedId !== null) : T.status.invalid}
          </p>
        )}
        {mode === "draft" && savedId && (
          <div ref={problemsRef} tabIndex={-1} className="outline-none">
            {problems.length > 0 ? (
              <Alert aria-label={T.summaryTitle}>
                <AlertDescription className="flex flex-col gap-1">
                  <strong className="font-medium">{T.summaryTitle}</strong>
                  <ul className="list-disc pl-4">
                    {problems.map((problem) => {
                      const target = fieldTarget(problem.field, values, accounts.length);
                      return (
                        <li key={`${problem.field}-${problem.message}`}>
                          {target.external ? (
                            <Link className="underline" href={target.href}>
                              {problem.message}
                            </Link>
                          ) : (
                            <a className="underline" href={target.href}>
                              {problem.message}
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">{T.summaryOk}</p>
            )}
          </div>
        )}
        {message && (
          <Alert variant={message.ok ? "default" : "destructive"} role="status">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        {notices.map((notice) => (
          <Alert key={notice} role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ))}

        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.parties}</h2>
            {mode === "draft" ? (
              <>
                <CustomerPicker
                  name={customerName}
                  invalid={problems.some((problem) => problem.field === "customerId")}
                  onNameChange={(name) => {
                    setCustomerName(name);
                    setValues((current) => ({ ...current, customerId: null }));
                  }}
                  onPick={pickCustomer}
                />
                <Field id="field-seriesId" label={F.series}>
                  <NativeSelect
                    id="field-seriesId"
                    value={values.seriesId ?? ""}
                    onChange={(event) => set("seriesId", event.target.value || null)}
                  >
                    <option value="">{T.defaultSeries}</option>
                    {series.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </>
            ) : (
              <>
                <p className="text-sm">
                  <span className="text-muted-foreground">{F.customer}: </span>
                  {customerName}
                </p>
                <Field id="field-number" label={F.number}>
                  <Input
                    id="field-number"
                    value={number}
                    required
                    onChange={(event) => setNumber(event.target.value)}
                  />
                </Field>
              </>
            )}
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.dates}</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="field-issueDate" label={F.issueDate}>
                <Input
                  id="field-issueDate"
                  type="date"
                  value={values.issueDate}
                  onChange={(event) => {
                    const { value } = event.target;
                    setValues((current) => changeIssueDate(current, value, touched.current));
                    touched.current.add("issueDate");
                  }}
                />
              </Field>
              <Field id="field-dueDate" label={F.dueDate}>
                <Input
                  id="field-dueDate"
                  type="date"
                  value={values.dueDate}
                  onChange={(event) => set("dueDate", event.target.value)}
                />
              </Field>
              <Field id="field-taxableDate" label={F.taxableDate}>
                <Input
                  id="field-taxableDate"
                  type="date"
                  value={values.taxableDate}
                  onChange={(event) => set("taxableDate", event.target.value)}
                />
              </Field>
              <Field id="field-currency" label={F.currency}>
                <NativeSelect
                  id="field-currency"
                  value={values.currency}
                  onChange={(event) => {
                    const currency = event.target.value as Currency;
                    touched.current.add("currency");
                    setValues((current) =>
                      changeCurrency(current, currency, touched.current, accounts),
                    );
                  }}
                >
                  {CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {showRate && (
                <Field id="field-exchangeRate" label={F.exchangeRate}>
                  <Input
                    id="field-exchangeRate"
                    inputMode="decimal"
                    aria-invalid={invalid.has("field-exchangeRate") || undefined}
                    value={values.exchangeRate}
                    onChange={(event) => set("exchangeRate", event.target.value)}
                  />
                </Field>
              )}
              <Field id="field-language" label={F.language}>
                <NativeSelect
                  id="field-language"
                  value={values.language}
                  onChange={(event) =>
                    set("language", event.target.value as FormValues["language"])
                  }
                >
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {P.languages[language]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="field-paymentMethod" label={F.paymentMethod}>
                <NativeSelect
                  id="field-paymentMethod"
                  value={values.paymentMethod}
                  onChange={(event) =>
                    set("paymentMethod", event.target.value as FormValues["paymentMethod"])
                  }
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {P.paymentMethods[method]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field id="field-bankAccountId" label={F.bankAccount}>
                <NativeSelect
                  id="field-bankAccountId"
                  value={values.bankAccountId ?? ""}
                  onChange={(event) => set("bankAccountId", event.target.value || null)}
                >
                  <option value="">{T.noAccount}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.currency})
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.lines}</h2>
            <LineEditor
              lines={values.lines}
              currency={values.currency}
              nets={nets}
              units={units}
              defaultUnit={defaultUnit}
              invalid={invalid}
              onChange={(lines) => setValues((current) => ({ ...current, lines }))}
            />
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.totals}</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="field-discountKind" label={F.discountKind}>
                <NativeSelect
                  id="field-discountKind"
                  value={values.discountKind}
                  onChange={(event) =>
                    set("discountKind", event.target.value as FormValues["discountKind"])
                  }
                >
                  {DISCOUNT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {T.discounts[kind]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {values.discountKind !== "none" && (
                <Field id="field-discount" label={F.discountValue}>
                  <Input
                    id="field-discount"
                    inputMode="decimal"
                    aria-invalid={invalid.has("field-discount") || undefined}
                    value={values.discount}
                    onChange={(event) => set("discount", event.target.value)}
                  />
                </Field>
              )}
              <Field id="field-rounding" label={F.rounding}>
                <NativeSelect
                  id="field-rounding"
                  value={values.rounding}
                  onChange={(event) =>
                    set("rounding", event.target.value as FormValues["rounding"])
                  }
                >
                  {ROUNDING_MODES.map((option) => (
                    <option key={option} value={option}>
                      {P.roundings[option]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {totals ? (
              <dl
                data-testid="invoice-totals"
                className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm"
              >
                <dt className="text-muted-foreground">{T.subtotal}</dt>
                <dd className="text-right">{formatMoney(totals.subtotalMinor, values.currency)}</dd>
                {totals.discountMinor > 0 && (
                  <>
                    <dt className="text-muted-foreground">{T.discount}</dt>
                    <dd className="text-right">
                      {formatMoney(-totals.discountMinor, values.currency)}
                    </dd>
                  </>
                )}
                {totals.roundingMinor !== 0 && (
                  <>
                    <dt className="text-muted-foreground">{T.roundingDiff}</dt>
                    <dd className="text-right">
                      {formatMoney(totals.roundingMinor, values.currency)}
                    </dd>
                  </>
                )}
                <dt className="font-medium">{T.total}</dt>
                <dd className="text-right font-medium" data-testid="invoice-total">
                  {formatMoney(totals.totalMinor, values.currency)}
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{T.totalsUnavailable}</p>
            )}
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.texts}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="field-orderRef" label={F.orderRef}>
                <Input
                  id="field-orderRef"
                  value={values.orderRef}
                  onChange={(event) => set("orderRef", event.target.value)}
                />
              </Field>
              <Field id="field-reference" label={F.reference}>
                <Input
                  id="field-reference"
                  value={values.reference}
                  onChange={(event) => set("reference", event.target.value)}
                />
              </Field>
            </div>
            {(["textBefore", "textAfter", "note"] as const).map((field) => (
              <Field key={field} id={`field-${field}`} label={F[field]}>
                <Textarea
                  id={`field-${field}`}
                  value={values[field]}
                  onChange={(event) => set(field, event.target.value)}
                />
              </Field>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.appearance.showQr}
                onChange={(event) =>
                  set("appearance", { ...values.appearance, showQr: event.target.checked })
                }
              />
              {F.showQr}
            </label>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.tags}</h2>
            <TagInput tags={tags} options={tagOptions} onChange={setTags} />
          </section>

          <div>
            <Button type="submit" size="lg" disabled={busy}>
              {mode === "draft" ? T.issue : T.save}
            </Button>
          </div>
        </fieldset>
      </form>
      <PdfPreview id={savedId} revision={revision} />
      <IssueDialog
        summary={summary}
        pending={busy}
        error={dialogError}
        onCancel={() => setSummary(null)}
        onToday={applyToday}
        onConfirm={confirmIssue}
      />
    </div>
  );
}

// Next keeps visited routes alive, so without the key a link back here would show the old state,
// such as a draft form for a document issued in the meantime.
export function InvoiceForm(props: InvoiceFormProps) {
  const { bfcacheId } = useRouter();
  return (
    <Fragment key={bfcacheId}>
      <Form {...props} />
    </Fragment>
  );
}
