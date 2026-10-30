"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { lookupAresAction } from "@/app/(app)/ares-actions";
import { saveCustomerAction } from "@/app/(app)/zakaznici/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { CURRENCIES } from "@/lib/currency";
import { DOMESTIC_COUNTRY } from "@/lib/customers";
import { LANGUAGES, type DesignChoice } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.customers;

export type CustomerValues = {
  id?: string;
  name: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  ico: string;
  dic: string;
  email: string;
  extraEmails: string;
  phone: string;
  note: string;
  dueDays: string;
  language: string;
  currency: string;
  designId: string;
  remindersEnabled: string;
};

export const EMPTY_CUSTOMER: CustomerValues = {
  name: "",
  street: "",
  city: "",
  zip: "",
  country: DOMESTIC_COUNTRY,
  ico: "",
  dic: "",
  email: "",
  extraEmails: "",
  phone: "",
  note: "",
  dueDays: "",
  language: "",
  currency: "",
  designId: "",
  remindersEnabled: "",
};

type TextField = Exclude<keyof CustomerValues, "id">;

function Field({
  name,
  value,
  onChange,
  type = "text",
  required,
}: {
  name: TextField;
  value: string;
  onChange: (name: TextField, value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`customer-${name}`}>{T.fields[name]}</Label>
      <Input
        id={`customer-${name}`}
        name={name}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </div>
  );
}

function Choice({
  name,
  value,
  onChange,
  options,
}: {
  name: TextField;
  value: string;
  onChange: (name: TextField, value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`customer-${name}`}>{T.fields[name]}</Label>
      <NativeSelect
        id={`customer-${name}`}
        name={name}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
      >
        <option value="">{T.inherit}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function toPayload(values: CustomerValues) {
  const { dueDays, language, currency, designId, remindersEnabled, extraEmails, ...rest } = values;
  return {
    ...rest,
    extraEmails: extraEmails
      .split(/[,;\n]/)
      .map((email) => email.trim())
      .filter(Boolean),
    dueDays: dueDays === "" ? null : Number(dueDays),
    language: language || null,
    currency: currency || null,
    designId: designId || null,
    remindersEnabled: remindersEnabled === "" ? null : remindersEnabled === "1",
  };
}

export function CustomerForm({
  initial,
  designs,
}: {
  initial: CustomerValues | null;
  designs: DesignChoice[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<CustomerValues>(initial ?? EMPTY_CUSTOMER);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const change = (name: TextField, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function fillFromAres() {
    startTransition(async () => {
      const response = await lookupAresAction({ ico: values.ico });
      if (!response.ok || !response.result) {
        setMessage({ ok: false, text: T.aresNotFound });
        return;
      }
      const { name, dic, street, city, zip, country } = response.result;
      setValues((current) => ({
        ...current,
        name,
        dic: dic || current.dic,
        street,
        city,
        zip,
        country: country || current.country,
      }));
      setMessage({ ok: true, text: T.aresFound });
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveCustomerAction(toPayload(values));
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      if (!values.id) {
        router.push(`/zakaznici/${result.id}`);
        return;
      }
      setMessage({ ok: true, text: T.saved });
      router.refresh();
    });
  }

  const fieldProps = { onChange: change };

  return (
    <form onSubmit={submit} className="flex flex-col gap-8 sm:max-w-xl">
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.identity}</h2>
        <Field name="ico" value={values.ico} {...fieldProps} />
        <div>
          <Button type="button" variant="outline" disabled={pending} onClick={fillFromAres}>
            {pending ? T.aresLoading : T.ares}
          </Button>
        </div>
        <Field name="name" value={values.name} required {...fieldProps} />
        <Field name="dic" value={values.dic} {...fieldProps} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.address}</h2>
        <Field name="street" value={values.street} {...fieldProps} />
        <Field name="city" value={values.city} {...fieldProps} />
        <Field name="zip" value={values.zip} {...fieldProps} />
        <Field name="country" value={values.country} {...fieldProps} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.contact}</h2>
        <Field name="email" type="email" value={values.email} {...fieldProps} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="customer-extraEmails">{T.fields.extraEmails}</Label>
          <Input
            id="customer-extraEmails"
            name="extraEmails"
            value={values.extraEmails}
            aria-describedby="customer-extraEmails-hint"
            onChange={(event) => change("extraEmails", event.target.value)}
          />
          <p id="customer-extraEmails-hint" className="text-xs text-muted-foreground">
            {T.extraEmailsHint}
          </p>
        </div>
        <Field name="phone" type="tel" value={values.phone} {...fieldProps} />
        <Field name="note" value={values.note} {...fieldProps} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">{T.sections.exceptions}</h2>
        <p className="text-sm text-muted-foreground">{T.exceptionsHint}</p>
        <Field name="dueDays" type="number" value={values.dueDays} {...fieldProps} />
        <Choice
          name="language"
          value={values.language}
          options={LANGUAGES.map((value) => ({
            value,
            label: TEXTS.preferences.languages[value],
          }))}
          {...fieldProps}
        />
        <Choice
          name="currency"
          value={values.currency}
          options={CURRENCIES.map((value) => ({ value, label: value }))}
          {...fieldProps}
        />
        <Choice
          name="designId"
          value={values.designId}
          options={designs.map(({ id, name }) => ({ value: id, label: name }))}
          {...fieldProps}
        />
        <Choice
          name="remindersEnabled"
          value={values.remindersEnabled}
          options={[
            { value: "1", label: T.remindersOn },
            { value: "0", label: T.remindersOff },
          ]}
          {...fieldProps}
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
