"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import {
  clearOwnSmtpAction,
  saveMailSettingsAction,
  sendTestMailAction,
} from "@/app/(app)/nastaveni/posta/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MailSettingsInput } from "@/lib/mail-settings";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.mailSettings;

type Outcome = { ok: true } | { ok: false; error: string };
type Message = { ok: boolean; text: string } | null;

type Settings = {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  fromEmail: string | null;
  senderName: string | null;
  replyTo: string | null;
  cc: string[];
  bcc: string[];
  verifiedAt: Date | null;
  hasCredentials: boolean;
};

type Availability = { available: boolean; source: "user" | "instance" | null };
type Field = keyof MailSettingsInput;

function toFields(settings: Settings): Record<Field, string> {
  return {
    smtpHost: settings.smtpHost ?? "",
    smtpPort: settings.smtpPort?.toString() ?? "",
    smtpUser: settings.smtpUser ?? "",
    smtpPassword: "",
    fromEmail: settings.fromEmail ?? "",
    senderName: settings.senderName ?? "",
    replyTo: settings.replyTo ?? "",
    cc: settings.cc.join(", "),
    bcc: settings.bcc.join(", "),
  };
}

function statusText({ available, source }: Availability): string {
  if (!available) return T.status.unavailable;
  return source === "user" ? T.status.user : T.status.instance;
}

function TextField({
  name,
  label,
  hint,
  type = "text",
  autoComplete = "off",
  fields,
  onChange,
}: {
  name: Field;
  label: string;
  hint?: string;
  type?: string;
  autoComplete?: string;
  fields: Record<Field, string>;
  onChange: (name: Field, value: string) => void;
}) {
  const id = `mail-${name}`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        value={fields[name]}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(name, event.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function ClearDialog({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" disabled={disabled} />}>
        {T.clear}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.clearTitle}</AlertDialogTitle>
          <AlertDialogDescription>{T.clearBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {T.clear}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function MailSettingsForm({
  settings,
  availability,
}: {
  settings: Settings;
  availability: Availability;
}) {
  const [fields, setFields] = useState(() => toFields(settings));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const change = (name: Field, value: string) =>
    setFields((current) => ({ ...current, [name]: value }));

  function perform(run: () => Promise<Outcome>, success: string, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const result = await run();
      setMessage(result.ok ? { ok: true, text: success } : { ok: false, text: result.error });
      if (result.ok) after?.();
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    perform(
      () => saveMailSettingsAction(fields),
      T.saved,
      () => change("smtpPassword", ""),
    );
  }

  function clear() {
    perform(clearOwnSmtpAction, T.cleared, () =>
      setFields((current) => ({
        ...current,
        smtpHost: "",
        smtpPort: "",
        smtpUser: "",
        smtpPassword: "",
        fromEmail: "",
      })),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert variant={availability.available ? "default" : "destructive"}>
        <AlertDescription>
          {statusText(availability)}
          {settings.smtpHost && (
            <span className="mt-1 block">
              {settings.verifiedAt ? T.status.verified : T.status.unverified}
            </span>
          )}
        </AlertDescription>
      </Alert>

      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <section className="flex max-w-xl flex-col gap-1 rounded-lg border p-4">
        <h2 className="text-lg">
          <Link href="/nastaveni/posta/sablony" className="underline">
            {TEXTS.emailTemplates.link}
          </Link>
        </h2>
        <p className="text-sm text-muted-foreground">{TEXTS.emailTemplates.linkBody}</p>
      </section>

      <form onSubmit={save} className="flex max-w-xl flex-col gap-6">
        <section className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 className="text-lg">{T.identity.title}</h2>
          <TextField
            name="senderName"
            label={T.identity.senderName}
            fields={fields}
            onChange={change}
          />
          <TextField
            name="replyTo"
            label={T.identity.replyTo}
            type="email"
            fields={fields}
            onChange={change}
          />
          <TextField
            name="cc"
            label={T.identity.cc}
            hint={T.identity.listHint}
            fields={fields}
            onChange={change}
          />
          <TextField
            name="bcc"
            label={T.identity.bcc}
            hint={T.identity.listHint}
            fields={fields}
            onChange={change}
          />
        </section>

        <section className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 className="text-lg">{T.smtp.title}</h2>
          <p className="text-sm text-muted-foreground">{T.smtp.body}</p>
          <TextField name="smtpHost" label={T.smtp.host} fields={fields} onChange={change} />
          <TextField
            name="smtpPort"
            label={T.smtp.port}
            hint={T.smtp.portHint}
            fields={fields}
            onChange={change}
          />
          <TextField
            name="fromEmail"
            label={T.smtp.fromEmail}
            type="email"
            fields={fields}
            onChange={change}
          />
          <TextField name="smtpUser" label={T.smtp.user} fields={fields} onChange={change} />
          <TextField
            name="smtpPassword"
            label={T.smtp.password}
            hint={settings.hasCredentials ? T.smtp.passwordStored : undefined}
            type="password"
            autoComplete="new-password"
            fields={fields}
            onChange={change}
          />
        </section>

        <div>
          <Button type="submit" disabled={pending}>
            {T.save}
          </Button>
        </div>
      </form>

      <section className="flex max-w-xl flex-col gap-3">
        <p className="text-sm text-muted-foreground">{T.testHint}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending || !availability.available}
            onClick={() => perform(sendTestMailAction, T.testSent)}
          >
            {T.test}
          </Button>
          {settings.smtpHost && <ClearDialog disabled={pending} onConfirm={clear} />}
        </div>
      </section>
    </div>
  );
}
