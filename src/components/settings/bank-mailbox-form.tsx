"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  clearBankMailboxAction,
  saveBankMailboxAction,
  testBankMailboxAction,
} from "@/app/(app)/nastaveni/aviza/actions";
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
import { NativeSelect } from "@/components/ui/native-select";
import type { BankTlsMode } from "@/lib/bank-mailbox";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import type { BankMailboxView } from "@/server/services/bank-mailbox";

const T = TEXTS.bankMailbox;
const F = T.form;

type Outcome = { ok: true } | { ok: false; error: string };
type Message = { ok: boolean; text: string } | null;

type TextName = "host" | "port" | "username" | "password" | "folder";

type Fields = {
  host: string;
  port: string;
  tls: BankTlsMode;
  username: string;
  password: string;
  folder: string;
  enabled: boolean;
  requireConfirmation: boolean;
};

function toFields(settings: BankMailboxView | null): Fields {
  return {
    host: settings?.host ?? "",
    port: String(settings?.port ?? 993),
    tls: settings?.tls ?? "implicit",
    username: settings?.username ?? "",
    password: "",
    folder: settings?.folder ?? "INBOX",
    enabled: settings?.enabled ?? true,
    requireConfirmation: settings?.requireConfirmation ?? true,
  };
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
  name: TextName;
  label: string;
  hint?: string | undefined;
  type?: string;
  autoComplete?: string;
  fields: Fields;
  onChange: (name: TextName, value: string) => void;
}) {
  const id = `bank-${name}`;
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

function Status({ settings }: { settings: BankMailboxView | null }) {
  const S = T.status;
  if (!settings) {
    return (
      <Alert>
        <AlertDescription>{S.none}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant={settings.failureCode ? "destructive" : "default"}>
      <AlertDescription className="flex flex-col gap-1">
        <span>{settings.enabled ? (settings.verifiedAt ? S.verified : S.unverified) : S.off}</span>
        <span>
          {S.lastCheck}: {settings.lastCheckAt ? formatDateTime(settings.lastCheckAt) : S.never}
        </span>
        <span>
          {S.lastSuccess}:{" "}
          {settings.lastSuccessAt ? formatDateTime(settings.lastSuccessAt) : S.never}
        </span>
        <span>
          {S.lastNotice}: {settings.lastNoticeAt ? formatDateTime(settings.lastNoticeAt) : S.never}
        </span>
        {settings.failureCode && (
          <span>
            {T.failure[settings.failureCode]} {S.failures(settings.failures)}
          </span>
        )}
      </AlertDescription>
    </Alert>
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

export function BankMailboxForm({ settings }: { settings: BankMailboxView | null }) {
  const [fields, setFields] = useState(() => toFields(settings));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const change = <K extends keyof Fields>(name: K, value: Fields[K]) =>
    setFields((current) => ({ ...current, [name]: value }));
  const setText = (name: TextName, value: string) => change(name, value);

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
      () => saveBankMailboxAction(fields),
      T.saved,
      () => change("password", ""),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Status settings={settings} />

      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={save} className="flex max-w-xl flex-col gap-6">
        <section className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 className="text-lg">{F.title}</h2>
          <TextField name="host" label={F.host} fields={fields} onChange={setText} />
          <TextField
            name="port"
            label={F.port}
            hint={F.portHint}
            fields={fields}
            onChange={setText}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="bank-tls">{F.tls}</Label>
            <NativeSelect
              id="bank-tls"
              value={fields.tls}
              onChange={(event) => change("tls", event.target.value as BankTlsMode)}
            >
              <option value="implicit">{F.tlsImplicit}</option>
              <option value="starttls">{F.tlsStarttls}</option>
            </NativeSelect>
          </div>
          <TextField name="username" label={F.username} fields={fields} onChange={setText} />
          <TextField
            name="password"
            label={F.password}
            hint={settings?.hasCredentials ? F.passwordStored : undefined}
            type="password"
            autoComplete="new-password"
            fields={fields}
            onChange={setText}
          />
          <TextField
            name="folder"
            label={F.folder}
            hint={F.folderHint}
            fields={fields}
            onChange={setText}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fields.enabled}
              onChange={(event) => change("enabled", event.target.checked)}
            />
            {F.enabled}
          </label>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fields.requireConfirmation}
                aria-describedby="bank-confirmation-hint"
                onChange={(event) => change("requireConfirmation", event.target.checked)}
              />
              {F.requireConfirmation}
            </label>
            <p id="bank-confirmation-hint" className="text-sm text-muted-foreground">
              {F.requireConfirmationHint}
            </p>
          </div>
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
            disabled={pending || !settings}
            onClick={() => perform(testBankMailboxAction, T.tested)}
          >
            {T.test}
          </Button>
          {settings && (
            <ClearDialog
              disabled={pending}
              onConfirm={() =>
                perform(clearBankMailboxAction, T.cleared, () => setFields(toFields(null)))
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}
