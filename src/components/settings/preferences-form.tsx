"use client";

import { useState, useTransition, type FormEvent } from "react";
import { savePreferencesAction } from "@/app/(app)/nastaveni/vychozi/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import {
  DATE_FORMATS,
  ISSUE_DATE_MODES,
  LANGUAGES,
  PAYMENT_METHODS,
  VARIABLE_SYMBOL_FORMATS,
  type Preferences,
} from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.preferences;

type FlagKey = "showLogo" | "showQr" | "showQrLogo" | "showSignature" | "showDuzp";
type TextKey = "unit" | "accentColor" | "textBefore" | "textAfter" | "note";
type ChoiceKey =
  | "language"
  | "currency"
  | "designId"
  | "paymentMethod"
  | "issueDateMode"
  | "dateFormat"
  | "variableSymbolFormat";

const FLAGS: FlagKey[] = ["showLogo", "showQr", "showQrLogo", "showSignature", "showDuzp"];

const CHOICES: Record<ChoiceKey, { values: readonly string[]; label: (value: string) => string }> =
  {
    language: { values: LANGUAGES, label: (v) => T.languages[v as keyof typeof T.languages] },
    currency: { values: CURRENCIES, label: (v) => v },
    designId: { values: ["cisty"], label: (v) => T.designs[v as keyof typeof T.designs] },
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
  };

export function ChoiceField({
  name,
  value,
  onChange,
  idPrefix = "pref",
}: {
  name: ChoiceKey;
  value: string;
  onChange: (name: ChoiceKey, value: string) => void;
  idPrefix?: string;
}) {
  const choice = CHOICES[name];
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${idPrefix}-${name}`}>{T.fields[name]}</Label>
      <NativeSelect
        id={`${idPrefix}-${name}`}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
      >
        {choice.values.map((option) => (
          <option key={option} value={option}>
            {choice.label(option)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function PreferencesForm({ initial }: { initial: Preferences }) {
  const [values, setValues] = useState<Preferences>(initial);
  const [dueDays, setDueDays] = useState(String(initial.dueDays));
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
        {name === "accentColor" && <p className="text-sm text-muted-foreground">{T.accentHint}</p>}
      </div>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await savePreferencesAction({
        ...values,
        dueDays: dueDays.trim() === "" ? Number.NaN : Number(dueDays),
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
        {text("unit")}
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.look}</h2>
        <ChoiceField name="designId" value={values.designId} onChange={choose} />
        {text("accentColor")}
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
      <div>
        <Button type="submit" disabled={pending}>
          {T.save}
        </Button>
      </div>
    </form>
  );
}
