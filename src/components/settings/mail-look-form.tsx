"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  removeMailLogoAction,
  saveMailLookAction,
  uploadMailLogoAction,
} from "@/app/(app)/nastaveni/posta/vzhled/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_FILE_BYTES } from "@/lib/file-limits";
import {
  DEFAULT_MAIL_LAYOUT,
  MAIL_LAYOUTS,
  MAIL_LOGO_MODES,
  MAIL_LOOK_TEXT_MAX,
  type MailLayout,
  type MailLogoMode,
} from "@/lib/mail-look";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.mailLook;

type Look = {
  layout: MailLayout;
  intro: string | null;
  signature: string | null;
  logoMode: MailLogoMode;
  logoFileId: string | null;
};

type Message = { ok: boolean; text: string } | null;

export function MailLookForm({ look }: { look: Look }) {
  const [layout, setLayout] = useState<MailLayout>(look.layout);
  const [logoMode, setLogoMode] = useState<MailLogoMode>(look.logoMode);
  const [intro, setIntro] = useState(look.intro ?? "");
  const [signature, setSignature] = useState(look.signature ?? "");
  const [message, setMessage] = useState<Message>(null);
  // Bumped after a save, so the preview shows the stored texts and logo.
  const [version, setVersion] = useState(0);
  const [pending, startTransition] = useTransition();

  function done(result: { ok: true } | { ok: false; error: string }, text: string) {
    setMessage(result.ok ? { ok: true, text } : { ok: false, text: result.error });
    if (result.ok) setVersion((value) => value + 1);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      done(await saveMailLookAction({ layout, intro, signature, logoMode }), T.saved);
    });
  }

  function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setMessage({ ok: false, text: TEXTS.supplier.images.tooBig });
      return;
    }
    const data = new FormData();
    data.set("file", file);
    startTransition(async () => {
      const result = await uploadMailLogoAction(data);
      if (result.ok) setLogoMode("custom");
      done(result, T.logoSaved);
    });
  }

  function removeLogo() {
    startTransition(async () => {
      const result = await removeMailLogoAction();
      if (result.ok && logoMode === "custom") setLogoMode("supplier");
      done(result, T.logoRemoved);
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <form onSubmit={save} className="flex flex-col gap-6">
        {message && (
          <Alert variant={message.ok ? "default" : "destructive"} role="status">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-lg">{T.layout}</legend>
          {MAIL_LAYOUTS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:bg-muted has-checked:border-primary"
            >
              <input
                type="radio"
                name="layout"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                value={option}
                checked={layout === option}
                onChange={() => setLayout(option)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {T.layouts[option].name}
                  {option === DEFAULT_MAIL_LAYOUT && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {T.defaultBadge}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">{T.layouts[option].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <Label htmlFor="mail-look-intro">{T.introLabel}</Label>
          <Textarea
            id="mail-look-intro"
            rows={3}
            maxLength={MAIL_LOOK_TEXT_MAX}
            value={intro}
            onChange={(event) => setIntro(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mail-look-signature">{T.signatureLabel}</Label>
          <Textarea
            id="mail-look-signature"
            rows={3}
            maxLength={MAIL_LOOK_TEXT_MAX}
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{T.textHint}</p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-lg">{T.logo}</legend>
          {MAIL_LOGO_MODES.map((mode) => (
            <label key={mode} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="logoMode"
                className="size-4 accent-primary"
                value={mode}
                checked={logoMode === mode}
                onChange={() => setLogoMode(mode)}
              />
              {T.logoModes[mode]}
            </label>
          ))}
          {look.logoFileId ? (
            // oxlint-disable-next-line nextjs/no-img-element
            <img
              src={`/soubory/${look.logoFileId}`}
              alt={T.logoModes.custom}
              className="max-h-20 max-w-60 rounded-md border bg-card object-contain p-1"
            />
          ) : (
            logoMode === "custom" && (
              <p className="text-sm text-muted-foreground">{T.noCustomLogo}</p>
            )
          )}
          <Label htmlFor="mail-look-logo">{T.logoUpload}</Label>
          <Input
            id="mail-look-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            disabled={pending}
            onChange={(event) => {
              upload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <p className="text-xs text-muted-foreground">{T.logoHint}</p>
          {look.logoFileId && (
            <div>
              <Button type="button" variant="outline" disabled={pending} onClick={removeLogo}>
                {T.logoRemove}
              </Button>
            </div>
          )}
        </fieldset>

        <div>
          <Button type="submit" disabled={pending}>
            {T.save}
          </Button>
        </div>
      </form>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg">{T.preview}</h2>
        <iframe
          title={T.previewTitle(T.layouts[layout].name)}
          sandbox=""
          src={`/nastaveni/posta/vzhled/nahled?layout=${layout}&v=${version}`}
          className="h-[44rem] w-full rounded-md border bg-background"
        />
      </section>
    </div>
  );
}
