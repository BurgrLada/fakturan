"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { saveBankAccountAction } from "@/app/(app)/nastaveni/ucty/actions";
import { lookupAresAction, saveSupplierAction } from "@/app/(app)/nastaveni/dodavatel/actions";
import {
  completeOnboardingAction,
  ensureSeriesAction,
  savePreferencesAction,
} from "@/app/(app)/nastaveni/vychozi/actions";
import { ChoiceField } from "@/components/settings/preferences-form";
import { ImageSlot, type SupplierValues } from "@/components/settings/supplier-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants, Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ONBOARDING_STEPS, type OnboardingStep } from "@/lib/onboarding";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.onboarding;

export type OnboardingProps = {
  step: OnboardingStep;
  supplier: SupplierValues;
  logoFileId: string | null;
  series: { id: string; name: string; template: string }[];
  language: string;
  designId: string;
};

type Message = { ok: boolean; text: string } | null;

function stepHref(step: OnboardingStep) {
  return `/pruvodce?krok=${step}`;
}

function nextStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1] ?? null;
}

function Notice({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <Alert variant={message.ok ? "default" : "destructive"} role="status">
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}

function TextInput({
  id,
  label,
  value,
  onChange,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SupplierStep({ initial, go }: { initial: SupplierValues; go: () => void }) {
  const [values, setValues] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const F = TEXTS.supplier.fields;
  const set = (name: keyof SupplierValues) => (value: string) =>
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
      if (result.ok) go();
      else setMessage({ ok: false, text: result.error });
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{T.supplierIntro}</p>
      <Notice message={message} />
      <TextInput id="ob-ico" label={F.ico} value={values.ico} onChange={set("ico")} required />
      <div>
        <Button type="button" variant="outline" disabled={pending} onClick={fillFromAres}>
          {pending ? TEXTS.supplier.aresLoading : TEXTS.supplier.ares}
        </Button>
      </div>
      <TextInput id="ob-name" label={F.name} value={values.name} onChange={set("name")} required />
      <TextInput
        id="ob-street"
        label={F.street}
        value={values.street}
        onChange={set("street")}
        required
      />
      <TextInput id="ob-city" label={F.city} value={values.city} onChange={set("city")} required />
      <TextInput id="ob-zip" label={F.zip} value={values.zip} onChange={set("zip")} required />
      <TextInput
        id="ob-country"
        label={F.country}
        value={values.country}
        onChange={set("country")}
        required
      />
      <div>
        <Button type="submit" disabled={pending}>
          {T.next}
        </Button>
      </div>
    </form>
  );
}

function AccountStep({ go }: { go: () => void }) {
  const [values, setValues] = useState({ name: "", number: "", bankCode: "", iban: "" });
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const F = TEXTS.bankAccounts.fields;
  const set = (name: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveBankAccountAction({ ...values, currency: "CZK", swift: "" });
      if (result.ok) go();
      else setMessage({ ok: false, text: result.error });
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{T.accountIntro}</p>
      <Notice message={message} />
      <TextInput id="ob-acc-name" label={F.name} value={values.name} onChange={set("name")} />
      <TextInput
        id="ob-acc-number"
        label={F.number}
        value={values.number}
        onChange={set("number")}
      />
      <TextInput
        id="ob-acc-bank"
        label={F.bankCode}
        value={values.bankCode}
        onChange={set("bankCode")}
      />
      <TextInput id="ob-acc-iban" label={F.iban} value={values.iban} onChange={set("iban")} />
      <div>
        <Button type="submit" disabled={pending}>
          {T.next}
        </Button>
      </div>
    </form>
  );
}

function SeriesStep({ series }: { series: OnboardingProps["series"] }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{T.seriesIntro}</p>
      {series.length === 0 && <p className="text-sm">{T.seriesPending}</p>}
      <ul className="flex flex-col gap-1 text-sm">
        {series.map((row) => (
          <li key={row.id}>
            {row.name}: <code>{row.template}</code>
          </li>
        ))}
      </ul>
      <div>
        <Link href="/nastaveni/rady" className={buttonVariants({ variant: "outline" })}>
          {T.seriesEdit}
        </Link>
      </div>
    </div>
  );
}

function LookStep({
  language,
  designId,
  go,
}: {
  language: string;
  designId: string;
  go: () => void;
}) {
  const [values, setValues] = useState({ language, designId });
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const choose = (name: "language" | "designId", value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await savePreferencesAction(values);
      if (result.ok) go();
      else setMessage({ ok: false, text: result.error });
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{T.lookIntro}</p>
      <Notice message={message} />
      <ChoiceField
        idPrefix="ob"
        name="language"
        value={values.language}
        onChange={(name, value) => choose(name as "language", value)}
      />
      <ChoiceField
        idPrefix="ob"
        name="designId"
        value={values.designId}
        onChange={(name, value) => choose(name as "designId", value)}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {T.finish}
        </Button>
      </div>
    </form>
  );
}

export function Onboarding(props: OnboardingProps) {
  const { step } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const following = nextStep(step);

  function finish() {
    startTransition(async () => {
      const result = await completeOnboardingAction();
      if (result.ok) router.push("/");
      else setError(result.error);
    });
  }

  function advance() {
    if (step === "series") {
      startTransition(async () => {
        const result = await ensureSeriesAction();
        if (!result.ok) setError(result.error);
        else if (following) router.push(stepHref(following));
      });
    } else if (following) router.push(stepHref(following));
    else finish();
  }

  const index = ONBOARDING_STEPS.indexOf(step);
  const previous = ONBOARDING_STEPS[index - 1];

  return (
    <div className="flex flex-col gap-6 sm:max-w-xl">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          {T.stepOf(index + 1, ONBOARDING_STEPS.length)}
        </p>
        <h2 className="text-lg">{T.steps[step]}</h2>
      </div>
      {error && (
        <Alert variant="destructive" role="status">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {step === "supplier" && <SupplierStep key={step} initial={props.supplier} go={advance} />}
      {step === "account" && <AccountStep key={step} go={advance} />}
      {step === "series" && <SeriesStep series={props.series} />}
      {step === "logo" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{T.logoIntro}</p>
          <ImageSlot kind="logo" fileId={props.logoFileId} />
        </div>
      )}
      {step === "look" && (
        <LookStep key={step} language={props.language} designId={props.designId} go={advance} />
      )}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {previous && (
          <Link href={stepHref(previous)} className={buttonVariants({ variant: "ghost" })}>
            {T.back}
          </Link>
        )}
        {(step === "series" || step === "logo") && (
          <Button type="button" disabled={pending} onClick={advance}>
            {following ? T.continue : T.finish}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={pending} onClick={advance}>
          {T.skipStep}
        </Button>
        <Link href="/" className={buttonVariants({ variant: "ghost" })}>
          {T.later}
        </Link>
      </div>
    </div>
  );
}
