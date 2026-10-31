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
  deleteDraftAction,
  issueAction,
  issuePreviewAction,
  saveDraftAction,
  updateIssuedAction,
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
  changeTaxableDate,
  computeFormTotals,
  customerOffer,
  discountNotes,
  draftFields,
  fieldTarget,
  nonEmptyLines,
  toDocumentFields,
  type AccountChoice,
  type CustomerOffer,
  type FormValues,
  type TouchedField,
} from "@/lib/invoice-form";
import { DISCOUNT_KINDS, ROUNDING_MODES } from "@/lib/invoice-totals";
import { formatMoney } from "@/lib/money";
import { setLeaveGuard } from "@/lib/leave-guard";
import { LANGUAGES, PAYMENT_METHODS, type DesignChoice } from "@/lib/preferences";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { useRouteShown } from "@/lib/use-route-shown";
import { AppearanceSection } from "./appearance-section";
import { CustomerPicker } from "./customer-picker";
import { IssueDialog, type IssueSummary } from "./issue-dialog";
import { LineEditor } from "./line-editor";
import { PdfPreview } from "./pdf-preview";
import { SaveTemplateDialog, TemplatesLink } from "./save-template-dialog";
import { TagInput } from "./tag-input";

const T = TEXTS.invoices.form;
const F = T.fields;
const P = TEXTS.preferences;
const TPL = TEXTS.invoices.templates.save;

type Problem = { field: string; message: string };
type Saved = { id: string; revision: number; problems: Problem[] };
type Payload = { draft: Record<string, unknown>; tags: string[] };

export type InvoiceFormProps = {
  id: string;
  saved: boolean;
  mailAvailable: boolean;
  hasPayments: boolean;
  type: string;
  mode: "draft" | "issued";
  status: string;
  number: string;
  variableSymbol: string;
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
  designs: DesignChoice[];
};

function payloadOf(type: string, values: FormValues, tags: string[]): Payload | null {
  const result = toDocumentFields(values);
  return result.ok ? { draft: draftFields(type, values, result.fields), tags } : null;
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
  if (status.kind === "stale" || status.kind === "expired") return "";
  return T.status[status.kind];
}

function offerRows(offer: CustomerOffer, accounts: InvoiceFormProps["accounts"]): string[] {
  const { currency, language, paymentMethod, dueDate, bankAccountId, appearance } = offer;
  const account = accounts.find((item) => item.id === bankAccountId);
  return [
    ...(currency ? [`${F.currency}: ${currency}`] : []),
    ...(bankAccountId !== undefined
      ? [`${F.bankAccount}: ${account ? account.name : T.noAccount}`]
      : []),
    ...(language ? [`${F.language}: ${P.languages[language]}`] : []),
    ...(paymentMethod ? [`${F.paymentMethod}: ${P.paymentMethods[paymentMethod]}`] : []),
    ...(dueDate ? [`${F.dueDate}: ${formatCalendarDate(dueDate, "d. M. yyyy")}`] : []),
    ...(appearance ? [T.appearance] : []),
  ];
}

function Form(props: InvoiceFormProps) {
  const { id, type, mode, accounts, series, units, tagOptions, defaultUnit, designs } = props;
  const router = useRouter();
  const [values, setValues] = useState(props.initial);
  const [tags, setTags] = useState(props.initialTags);
  const [number, setNumber] = useState(props.number);
  const [variableSymbol, setVariableSymbol] = useState(props.variableSymbol);
  const [customerName, setCustomerName] = useState(props.customerName);
  const [saved, setSaved] = useState(props.saved);
  const [revision, setRevision] = useState(props.revision);
  const [problems, setProblems] = useState(props.initialProblems);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [lock, setLock] = useState<"stale" | "expired" | null>(null);
  const locked = lock !== null;
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [resendOffer, setResendOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<IssueSummary | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [offer, setOffer] = useState<CustomerOffer | null>(null);
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { shown, root } = useRouteShown<HTMLDivElement>();

  const touched = useRef(new Set<TouchedField>());
  const identity = useRef({ exists: props.saved, revision: props.revision });
  const problemsRef = useRef<HTMLDivElement>(null);
  const customerTicket = useRef(0);
  const savedIssued = useRef(
    JSON.stringify([props.initial, props.initialTags, props.number, props.variableSymbol]),
  );
  const needsConfirm = useRef<() => boolean>(() => false);
  const latestValues = useRef(props.initial);

  const [saver] = useState(
    () =>
      new DraftSaver<Payload, Saved>({
        baseline: keyOf(payloadOf(type, props.initial, props.initialTags)),
        send: async ({ draft, tags: names }) => {
          const { exists, revision: current } = identity.current;
          const reference = exists ? { id, revision: current } : { clientId: id };
          const reply = await saveDraftAction({ draft: { ...draft, ...reference }, tags: names });
          if (reply.ok) return { kind: "saved", result: reply };
          if (reply.expired) return { kind: "expired" };
          if (reply.stale) return { kind: "stale" };
          return { kind: "rejected", error: reply.error };
        },
        onSaved: (result) => {
          identity.current = { exists: true, revision: result.revision };
          setSaved(true);
          setRevision(result.revision);
          setProblems(result.problems);
        },
        onStatus: (next) => {
          setStatus(next);
          if (next.kind === "stale" || next.kind === "expired") setLock(next.kind);
        },
      }),
  );

  const result = useMemo(() => toDocumentFields(values), [values]);
  const invalid = useMemo(() => new Set(result.ok ? [] : result.invalid), [result]);
  const totals = useMemo(() => computeFormTotals(values), [values]);
  const notes = useMemo(
    () => (result.ok && totals ? discountNotes(result.fields, totals) : []),
    [result, totals],
  );
  const nets = useMemo(() => {
    const kept = nonEmptyLines(values.lines);
    return new Map(kept.map((line, i) => [line.key, totals?.lines[i]?.netMinor ?? 0]));
  }, [values.lines, totals]);

  useEffect(() => {
    if (mode !== "draft" || !result.ok) return;
    const payload = { draft: draftFields(type, values, result.fields), tags };
    saver.change(keyOf(payload), payload);
  }, [mode, type, saver, values, tags, result]);

  useEffect(() => {
    latestValues.current = values;
    needsConfirm.current = () => {
      if (locked) return false;
      if (mode === "issued") {
        return JSON.stringify([values, tags, number, variableSymbol]) !== savedIssued.current;
      }
      return !result.ok || saver.hasFailed();
    };
  });

  useEffect(() => {
    const dirty = () => mode === "draft" && saver.isDirty();
    const warn = (event: BeforeUnloadEvent) => {
      if (needsConfirm.current() || dirty()) event.preventDefault();
    };
    // Next has no way to block a navigation, so links are stopped before its handler sees them.
    const guardLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      const stop = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (needsConfirm.current()) {
        if (!window.confirm(T.leaveConfirm)) stop();
      } else if (dirty()) {
        stop();
        void saver.flush().then((ok) => {
          if (ok || window.confirm(T.leaveConfirm)) router.push(url.pathname + url.search);
        });
      }
    };
    const dropLeaveGuard = setLeaveGuard(async () => {
      if (needsConfirm.current()) return window.confirm(T.leaveConfirm);
      if (!dirty() || (await saver.flush())) return true;
      return window.confirm(T.leaveConfirm);
    });
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => {
      dropLeaveGuard();
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLink, true);
      if (mode === "draft") void saver.flush();
    };
  }, [mode, router, saver]);

  function set<K extends TouchedField>(field: K, value: FormValues[K]) {
    touched.current.add(field);
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function pickCustomer(customer: { id: string; name: string }) {
    customerTicket.current += 1;
    const ticket = customerTicket.current;
    setOffer(null);
    setCustomerName(customer.name);
    setValues((current) => ({ ...current, customerId: customer.id }));
    try {
      const reply = await customerDefaultsAction({ customerId: customer.id });
      if (ticket !== customerTicket.current) return;
      if (!reply.ok) {
        if (reply.expired) setLock("expired");
        else setMessage({ ok: false, text: reply.error });
        return;
      }
      if (props.saved) {
        setOffer(customerOffer(latestValues.current, reply.defaults, touched.current, accounts));
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
    if (!first) return;
    const field = document.getElementById(first);
    const section = field?.closest("details");
    if (section) section.open = true;
    field?.focus();
  }

  async function flushedDocument(): Promise<boolean> {
    if (!(await saver.flush())) {
      if (!saver.isLocked()) setMessage({ ok: false, text: T.saveFailed });
      return false;
    }
    if (!identity.current.exists) setMessage({ ok: false, text: T.emptyDraft });
    return identity.current.exists;
  }

  async function startTemplate() {
    setMessage(null);
    if (!result.ok) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      if (await flushedDocument()) setNaming(true);
    } catch {
      setMessage({ ok: false, text: T.network });
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft() {
    setDeleting(false);
    setMessage(null);
    setBusy(true);
    try {
      await saver.halt();
      const reply = await deleteDraftAction({ id });
      if (reply.ok) {
        router.push("/faktury");
        return;
      }
      saver.resume();
      if (reply.expired) setLock("expired");
      else setMessage({ ok: false, text: reply.error });
    } catch {
      saver.resume();
      setMessage({ ok: false, text: T.network });
    } finally {
      setBusy(false);
    }
  }

  async function startIssue() {
    setMessage(null);
    if (!result.ok) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      if (!(await flushedDocument())) return;
      const preview = await issuePreviewAction({ id });
      if (!preview.ok) {
        if (preview.expired) setLock("expired");
        else setMessage({ ok: false, text: preview.error });
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
    const preview = await issuePreviewAction({ id });
    if (preview.ok) setSummary(preview);
    else setDialogError(preview.error);
  }

  async function applyToday() {
    if (!summary) return;
    const next = changeIssueDate(values, summary.today, touched.current);
    touched.current.add("issueDate");
    setValues(next);
    const payload = payloadOf(type, next, tags);
    if (!payload) return;
    setBusy(true);
    try {
      saver.change(keyOf(payload), payload);
      if (await saver.flush()) await reloadPreview();
      else setDialogError(T.saveFailed);
    } catch {
      setDialogError(T.network);
    } finally {
      setBusy(false);
    }
  }

  async function confirmIssue(variableSymbol: string | undefined) {
    setBusy(true);
    setDialogError(null);
    try {
      const issued = await issueAction({
        id,
        revision: identity.current.revision,
        variableSymbol,
      });
      if (issued.ok) {
        router.push(`/faktury/${issued.id}?vystaveno=1`);
        return;
      }
      if (issued.stale || issued.expired) {
        setSummary(null);
        setLock(issued.expired ? "expired" : "stale");
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
    setResendOffer(false);
    if (!result.ok) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      const reply = await updateIssuedAction({
        id,
        tags,
        document: { ...result.fields, number, variableSymbol, revision: identity.current.revision },
      });
      if (!reply.ok) {
        if (reply.expired) setLock("expired");
        else if (reply.stale) setLock("stale");
        else setMessage({ ok: false, text: reply.error });
        return;
      }
      identity.current.revision = reply.revision;
      const symbol = reply.variableSymbol ?? "";
      setVariableSymbol(symbol);
      savedIssued.current = JSON.stringify([values, tags, number, symbol]);
      setRevision(reply.revision);
      setMessage({ ok: true, text: T.saved });
      setResendOffer(reply.resendSuggested);
      setNotices([
        ...(reply.balanceWarning === "overpaid" ? [T.overpaid] : []),
        ...(reply.balanceWarning === "underpaid" ? [T.underpaid] : []),
        ...(reply.balanceWarning !== "none"
          ? [T.statusAfter(TEXTS.invoices.statuses[reply.status])]
          : []),
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
    <div ref={root} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
        {lock && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="flex flex-col items-start gap-2">
              {lock === "stale" ? TEXTS.invoices.stale : T.sessionExpired}
              <a
                className="underline"
                href={lock === "stale" ? `/faktury/${id}/upravit` : "/prihlaseni"}
              >
                {lock === "stale" ? T.refresh : T.login}
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
            {result.ok ? statusText(status, saved) : T.status.invalid}
          </p>
        )}
        {mode === "draft" && saved && (
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
            <AlertDescription>
              {message.text}
              {message.ok && message.text === TPL.saved && <TemplatesLink />}
            </AlertDescription>
          </Alert>
        )}
        {resendOffer && (
          <Alert role="status" data-testid="send-offer">
            <AlertDescription className="flex flex-col items-start gap-2">
              {T.resend}
              {props.mailAvailable && (
                <a className="underline underline-offset-4" href={`/faktury/${id}?odeslat=1`}>
                  {TEXTS.invoiceMail.detail.offerSend}
                </a>
              )}
            </AlertDescription>
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
                    customerTicket.current += 1;
                    setOffer(null);
                    setCustomerName(name);
                    setValues((current) => ({ ...current, customerId: null }));
                  }}
                  onPick={pickCustomer}
                  onExpired={() => setLock("expired")}
                />
                {offer && (
                  <Alert role="status" data-testid="customer-defaults">
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>{T.customerOffer.title}</span>
                      <ul className="list-disc pl-4">
                        {offerRows(offer, accounts).map((row) => (
                          <li key={row}>{row}</li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setValues((current) => ({ ...current, ...offer }));
                            setOffer(null);
                          }}
                        >
                          {T.customerOffer.apply}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setOffer(null)}
                        >
                          {T.customerOffer.keep}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
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
                <Field id="field-variableSymbol" label={F.variableSymbol}>
                  <Input
                    id="field-variableSymbol"
                    inputMode="numeric"
                    value={variableSymbol}
                    onChange={(event) => setVariableSymbol(event.target.value)}
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
                  onChange={(event) => {
                    const { value } = event.target;
                    touched.current.add("taxableDate");
                    setValues((current) => changeTaxableDate(current, value));
                  }}
                />
              </Field>
              <Field id="field-currency" label={F.currency}>
                <NativeSelect
                  id="field-currency"
                  disabled={props.hasPayments}
                  aria-describedby={props.hasPayments ? "field-currency-locked" : undefined}
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
                {props.hasPayments && (
                  <p id="field-currency-locked" className="text-xs text-muted-foreground">
                    {T.currencyLocked}
                  </p>
                )}
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
              onChange={(update) =>
                setValues((current) => ({ ...current, lines: update(current.lines) }))
              }
              onExpired={() => setLock("expired")}
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
            {notes.length > 0 && (
              <Alert role="status" data-testid="discount-notes">
                <AlertDescription className="flex flex-col gap-1">
                  {notes.map((note) => (
                    <span key={note}>{note}</span>
                  ))}
                </AlertDescription>
              </Alert>
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
          </section>

          <AppearanceSection
            value={values.appearance}
            designs={designs}
            invalid={invalid}
            onChange={(patch) => set("appearance", { ...values.appearance, ...patch })}
          />

          <section className="flex flex-col gap-4">
            <h2 className="text-lg">{T.sections.tags}</h2>
            <TagInput tags={tags} options={tagOptions} onChange={setTags} />
          </section>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="lg" disabled={busy}>
              {mode === "draft" ? T.issue : T.save}
            </Button>
            {mode === "draft" && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={() => void startTemplate()}
              >
                {TPL.trigger}
              </Button>
            )}
            {mode === "draft" && saved && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                {T.deleteDraft}
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      <PdfPreview id={saved ? id : null} revision={revision} />
      <IssueDialog
        summary={summary}
        pending={busy}
        error={dialogError}
        onCancel={() => setSummary(null)}
        onToday={applyToday}
        onConfirm={confirmIssue}
      />
      <SaveTemplateDialog id={id} open={naming} onOpenChange={setNaming} onResult={setMessage} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{T.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.deleteBack}</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void removeDraft()}>
              {T.deleteDraft}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
