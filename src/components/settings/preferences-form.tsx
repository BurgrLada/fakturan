"use client";

import { useState, useTransition, type FormEvent } from "react";
import { savePreferencesAction } from "@/app/(app)/nastaveni/vychozi/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import { formatRate, parseRate } from "@/lib/invoice-form";
import { ROUNDING_MODES } from "@/lib/invoice-totals";
import {
  DATE_FORMATS,
  FX_BASES,
  ISSUE_DATE_MODES,
  LANGUAGES,
  PAYMENT_METHODS,
  TURNOVER_BASES,
  VARIABLE_SYMBOL_FORMATS,
  type Preferences,
} from "@/lib/preferences";
import { formatMoney, formatMoneyInput, parseMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { FLAT_TAX_LIMIT_MINOR, VAT_REGISTRATION_LIMIT_MINOR } from "@/lib/turnover-limits";
import { FixedRates, FOREIGN_CURRENCIES } from "./fixed-rates";

const T = TEXTS.preferences;

type FlagKey = "showLogo" | "showQr" | "showQrLogo" | "showSignature" | "showDuzp";
type TextKey = "unit" | "pdfFileName" | "textBefore" | "textAfter" | "note";
type ChoiceKey =
  | "language"
  | "currency"
  | "designId"
  | "paymentMethod"
  | "issueDateMode"
  | "dateFormat"
  | "variableSymbolFormat"
  | "rounding"
  | "fxBasis"
  | "turnoverBasis";

export type ChoiceOption = { value: string; label: string };

// Owned by /nastaveni/designy and /nastaveni/automatizace: saving this form must not put back what
// was stale here.
const OWNED_ELSEWHERE: readonly string[] = [
  "advanceFinalMode",
  "designId",
  "accentColor",
  "surfaceColor",
  "textColor",
  "lineColor",
  "logoPosition",
];

const LIMIT_FIELDS = [
  { name: "turnoverVatLimitMinor", statutory: VAT_REGISTRATION_LIMIT_MINOR },
  { name: "turnoverFlatLimitMinor", statutory: FLAT_TAX_LIMIT_MINOR },
] as const;

const FLAGS: FlagKey[] = ["showLogo", "showQr", "showQrLogo", "showSignature", "showDuzp"];

const CHOICES: Record<
  Exclude<ChoiceKey, "designId">,
  { values: readonly string[]; label: (value: string) => string }
> = {
  language: { values: LANGUAGES, label: (v) => T.languages[v as keyof typeof T.languages] },
  currency: { values: CURRENCIES, label: (v) => v },
  paymentMethod: {
    values: PAYMENT_METHODS,
    label: (v) => T.paymentMethods[v as keyof typeof T.paymentMethods],
  },
  issueDateMode: {
    values: ISSUE_DATE_MODES,
    label: (v) => T.issueDateModes[v as keyof typeof T.issueDateModes],
  },
  dateFormat: {
    values: DATE_FORMATS,
    label: (v) => T.dateFormats[v as keyof typeof T.dateFormats],
  },
  variableSymbolFormat: {
    values: VARIABLE_SYMBOL_FORMATS,
    label: (v) => T.variableSymbolFormats[v as keyof typeof T.variableSymbolFormats],
  },
  rounding: {
    values: ROUNDING_MODES,
    label: (v) => T.roundings[v as keyof typeof T.roundings],
  },
  fxBasis: { values: FX_BASES, label: (v) => T.fxBases[v as keyof typeof T.fxBases] },
  turnoverBasis: {
    values: TURNOVER_BASES,
    label: (v) => T.turnoverBases[v as keyof typeof T.turnoverBases],
  },
};

export function ChoiceField({
  name,
  value,
  onChange,
  idPrefix = "pref",
  options,
}: {
  name: ChoiceKey;
  value: string;
  onChange: (name: ChoiceKey, value: string) => void;
  idPrefix?: string;
  options?: ChoiceOption[];
}) {
  const choices =
    options ??
    (name === "designId"
      ? []
      : CHOICES[name].values.map((option) => ({
          value: option,
          label: CHOICES[name as Exclude<ChoiceKey, "designId">].label(option),
        })));
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${idPrefix}-${name}`}>{T.fields[name]}</Label>
      <NativeSelect
        id={`${idPrefix}-${name}`}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
      >
        {choices.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function PreferencesForm({ initial }: { initial: Preferences }) {
  const [values, setValues] = useState<Preferences>(initial);
  const [dueDays, setDueDays] = useState(String(initial.dueDays));
  const [fixedRates, setFixedRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initial.fixedRates).map(([code, micros]) => [code, formatRate(micros)]),
    ),
  );
  const [limits, setLimits] = useState({
    turnoverVatLimitMinor:
      initial.turnoverVatLimitMinor === null ? "" : formatMoneyInput(initial.turnoverVatLimitMinor),
    turnoverFlatLimitMinor:
      initial.turnoverFlatLimitMinor === null
        ? ""
        : formatMoneyInput(initial.turnoverFlatLimitMinor),
  });
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof Preferences>(name: K, value: Preferences[K]) =>
    setValues((current) => ({ ...current, [name]: value }));
  const choose = (name: ChoiceKey, value: string) => set(name, value as never);

  function text(name: TextKey) {
    const id = `pref-${name}`;
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{T.fields[name]}</Label>
        <Input id={id} value={values[name]} onChange={(event) => set(name, event.target.value)} />
        {name === "pdfFileName" && (
          <p className="text-sm text-muted-foreground">{T.pdfFileNameHint}</p>
        )}
      </div>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rates = FOREIGN_CURRENCIES.flatMap((code) => {
      const text = fixedRates[code]?.trim();
      return text ? [[code, parseRate(text)] as const] : [];
    });
    const wrong = rates.find(([, micros]) => micros === null);
    if (wrong) {
      setMessage({ ok: false, text: T.fixedRates.invalid(wrong[0]) });
      return;
    }
    const parsedLimits = LIMIT_FIELDS.map(({ name }) => {
      const typed = limits[name].trim();
      return [name, typed === "" ? null : parseMoney(typed)] as const;
    });
    if (
      parsedLimits.some(
        ([name, minor]) => limits[name].trim() !== "" && (minor === null || minor < 1),
      )
    ) {
      setMessage({ ok: false, text: T.turnoverLimits.invalid });
      return;
    }
    startTransition(async () => {
      const owned = Object.entries(values).filter(([key]) => !OWNED_ELSEWHERE.includes(key));
      const result = await savePreferencesAction({
        ...Object.fromEntries(owned),
        dueDays: dueDays.trim() === "" ? Number.NaN : Number(dueDays),
        fixedRates: Object.fromEntries(rates),
        ...Object.fromEntries(parsedLimits),
      });
      setMessage(result.ok ? { ok: true, text: T.saved } : { ok: false, text: result.error });
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-8 sm:max-w-xl">
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.invoice}</h2>
        <div className="flex flex-col gap-2">
          <Label htmlFor="pref-dueDays">{T.fields.dueDays}</Label>
          <Input
            id="pref-dueDays"
            type="number"
            inputMode="numeric"
            value={dueDays}
            onChange={(event) => setDueDays(event.target.value)}
          />
        </div>
        <ChoiceField name="language" value={values.language} onChange={choose} />
        <ChoiceField name="currency" value={values.currency} onChange={choose} />
        <ChoiceField name="paymentMethod" value={values.paymentMethod} onChange={choose} />
        <ChoiceField name="rounding" value={values.rounding} onChange={choose} />
        {text("unit")}
        {text("pdfFileName")}
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.look}</h2>
        {FLAGS.map((name) => (
          <div key={name} className="flex items-center gap-2">
            <input
              id={`pref-${name}`}
              type="checkbox"
              className="size-4 accent-primary"
              checked={values[name]}
              onChange={(event) => set(name, event.target.checked)}
            />
            <Label htmlFor={`pref-${name}`}>{T.fields[name]}</Label>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.texts}</h2>
        {text("textBefore")}
        {text("textAfter")}
        {text("note")}
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.formats}</h2>
        <ChoiceField name="issueDateMode" value={values.issueDateMode} onChange={choose} />
        <ChoiceField name="dateFormat" value={values.dateFormat} onChange={choose} />
        <ChoiceField
          name="variableSymbolFormat"
          value={values.variableSymbolFormat}
          onChange={choose}
        />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.foreign}</h2>
        <ChoiceField name="fxBasis" value={values.fxBasis} onChange={choose} />
        <FixedRates
          rates={fixedRates}
          onChange={(code, text) => setFixedRates((current) => ({ ...current, [code]: text }))}
        />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.limits}</h2>
        <ChoiceField name="turnoverBasis" value={values.turnoverBasis} onChange={choose} />
        {LIMIT_FIELDS.map(({ name, statutory }) => (
          <div key={name} className="flex flex-col gap-2">
            <Label htmlFor={`pref-${name}`}>{T.fields[name]}</Label>
            <Input
              id={`pref-${name}`}
              inputMode="decimal"
              value={limits[name]}
              placeholder={formatMoneyInput(statutory)}
              onChange={(event) =>
                setLimits((current) => ({ ...current, [name]: event.target.value }))
              }
            />
            <p className="text-sm text-muted-foreground">
              {T.turnoverLimits.hint} {formatMoney(statutory, "CZK")}.
            </p>
          </div>
        ))}
      </section>
      <div>
        <Button type="submit" disabled={pending}>
          {T.save}
        </Button>
      </div>
    </form>
  );
}
