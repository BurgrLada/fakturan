"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  lookupAresAction,
  removeSupplierImageAction,
  saveSupplierAction,
  uploadSupplierImageAction,
} from "@/app/(app)/nastaveni/dodavatel/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TEXTS } from "@/lib/texts";

type Values = {
  name: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  ico: string;
  dic: string;
  email: string;
  phone: string;
  web: string;
  registryNote: string;
  contactPerson: string;
  vatIdentified: boolean;
  footerText: string;
  notVatPayerCs: string;
  notVatPayerEn: string;
};

type ImageKind = "logo" | "qr_logo" | "signature";

const EMPTY: Values = {
  name: "",
  street: "",
  city: "",
  zip: "",
  country: "Česká republika",
  ico: "",
  dic: "",
  email: "",
  phone: "",
  web: "",
  registryNote: "",
  contactPerson: "",
  vatIdentified: false,
  footerText: "",
  notVatPayerCs: "Nejsem plátce DPH.",
  notVatPayerEn: "I am not a VAT payer.",
};

const IMAGE_KINDS: ImageKind[] = ["logo", "qr_logo", "signature"];

type TextField = Exclude<keyof Values, "vatIdentified">;

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
      <Label htmlFor={`supplier-${name}`}>{TEXTS.supplier.fields[name]}</Label>
      <Input
        id={`supplier-${name}`}
        name={name}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </div>
  );
}

function ImageSlot({ kind, fileId }: { kind: ImageKind; fileId: string | null }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = TEXTS.supplier.images[kind];

  function upload(file: File | undefined) {
    if (!file) return;
    const data = new FormData();
    data.set("kind", kind);
    data.set("file", file);
    startTransition(async () => {
      const result = await uploadSupplierImageAction(data);
      setError(result.ok ? null : result.error);
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeSupplierImageAction({ kind });
      setError(result.ok ? null : result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`supplier-image-${kind}`}>{label}</Label>
      {fileId ? (
        // oxlint-disable-next-line nextjs/no-img-element
        <img
          src={`/soubory/${fileId}`}
          alt={label}
          className="max-h-24 max-w-48 rounded-md border bg-card object-contain p-1"
        />
      ) : (
        <p className="text-sm text-muted-foreground">{TEXTS.supplier.images.none}</p>
      )}
      <Input
        id={`supplier-image-${kind}`}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        disabled={pending}
        onChange={(event) => {
          upload(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {fileId && (
        <Button type="button" variant="outline" disabled={pending} onClick={remove}>
          {TEXTS.supplier.images.remove}
        </Button>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function SupplierForm({
  initial,
  images,
}: {
  initial: Values | null;
  images: Record<ImageKind, string | null>;
}) {
  const [values, setValues] = useState<Values>(initial ?? EMPTY);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const change = (name: TextField, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function fillFromAres() {
    startTransition(async () => {
      const response = await lookupAresAction({ ico: values.ico });
      if (!response.ok || !response.result) {
        setMessage({ ok: false, text: TEXTS.supplier.aresNotFound });
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
      setMessage({ ok: true, text: TEXTS.supplier.aresFound });
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveSupplierAction(values);
      setMessage(
        result.ok ? { ok: true, text: TEXTS.supplier.saved } : { ok: false, text: result.error },
      );
    });
  }

  const fieldProps = { onChange: change };

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={submit} className="flex flex-col gap-8 sm:max-w-xl">
        {message && (
          <Alert variant={message.ok ? "default" : "destructive"} role="status">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        <section className="flex flex-col gap-4">
          <h2 className="text-lg">{TEXTS.supplier.sections.identity}</h2>
          <Field name="ico" value={values.ico} required {...fieldProps} />
          <div>
            <Button type="button" variant="outline" disabled={pending} onClick={fillFromAres}>
              {pending ? TEXTS.supplier.aresLoading : TEXTS.supplier.ares}
            </Button>
          </div>
          <Field name="name" value={values.name} required {...fieldProps} />
        </section>
        <section className="flex flex-col gap-4">
          <h2 className="text-lg">{TEXTS.supplier.sections.address}</h2>
          <Field name="street" value={values.street} required {...fieldProps} />
          <Field name="city" value={values.city} required {...fieldProps} />
          <Field name="zip" value={values.zip} required {...fieldProps} />
          <Field name="country" value={values.country} required {...fieldProps} />
        </section>
        <section className="flex flex-col gap-4">
          <h2 className="text-lg">{TEXTS.supplier.sections.contact}</h2>
          <Field name="email" type="email" value={values.email} {...fieldProps} />
          <Field name="phone" type="tel" value={values.phone} {...fieldProps} />
          <Field name="web" value={values.web} {...fieldProps} />
          <Field name="contactPerson" value={values.contactPerson} {...fieldProps} />
          <Field name="registryNote" value={values.registryNote} {...fieldProps} />
        </section>
        <section className="flex flex-col gap-4">
          <h2 className="text-lg">{TEXTS.supplier.sections.vat}</h2>
          <div className="flex items-center gap-2">
            <input
              id="supplier-vatIdentified"
              type="checkbox"
              className="size-4 accent-primary"
              checked={values.vatIdentified}
              onChange={(event) =>
                setValues((current) => ({ ...current, vatIdentified: event.target.checked }))
              }
            />
            <Label htmlFor="supplier-vatIdentified">{TEXTS.supplier.fields.vatIdentified}</Label>
          </div>
          <Field name="dic" value={values.dic} required={values.vatIdentified} {...fieldProps} />
          <Field name="footerText" value={values.footerText} {...fieldProps} />
          <Field name="notVatPayerCs" value={values.notVatPayerCs} {...fieldProps} />
          <Field name="notVatPayerEn" value={values.notVatPayerEn} {...fieldProps} />
        </section>
        <div>
          <Button type="submit" disabled={pending}>
            {TEXTS.supplier.save}
          </Button>
        </div>
      </form>
      <section className="flex flex-col gap-4 sm:max-w-xl">
        <h2 className="text-lg">{TEXTS.supplier.sections.images}</h2>
        <p className="text-sm text-muted-foreground">{TEXTS.supplier.images.hint}</p>
        {IMAGE_KINDS.map((kind) => (
          <ImageSlot key={kind} kind={kind} fileId={images[kind]} />
        ))}
      </section>
    </div>
  );
}
