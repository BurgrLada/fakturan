"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  resetEmailTemplateAction,
  saveEmailTemplateAction,
} from "@/app/(app)/nastaveni/posta/sablony/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MessageKind } from "@/lib/email-template";
import { LANGUAGES, type Language } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.emailTemplates;

type Template = {
  kind: MessageKind;
  language: Language;
  subject: string;
  body: string;
  custom: boolean;
};

type Outcome = { ok: true } | { ok: false; error: string };
type Message = { ok: boolean; text: string } | null;

function TemplateCard({ template }: { template: Template }) {
  const { kind, language } = template;
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const id = `email-${kind}-${language}`;

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
    perform(() => saveEmailTemplateAction({ kind, language, subject, body }), T.saved);
  }

  function reset() {
    perform(() => resetEmailTemplateAction({ kind, language }), T.resetDone);
  }

  return (
    <form
      onSubmit={save}
      aria-labelledby={`${id}-title`}
      className="flex max-w-2xl flex-col gap-4 rounded-lg border p-4"
    >
      <h2 id={`${id}-title`} className="text-lg">
        {T.kinds[kind]}
      </h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-subject`}>{T.subject}</Label>
        <Input
          id={`${id}-subject`}
          value={subject}
          maxLength={200}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-body`}>{T.body}</Label>
        <Textarea
          id={`${id}-body`}
          value={body}
          rows={9}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {T.save}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !template.custom}
          onClick={reset}
        >
          {T.reset}
        </Button>
      </div>
    </form>
  );
}

export function EmailTemplateForm({
  templates,
  variables,
}: {
  templates: Template[];
  variables: readonly string[];
}) {
  const [language, setLanguage] = useState<Language>("cs");

  return (
    <div className="flex flex-col gap-6">
      <section className="flex max-w-2xl flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-lg">{T.variables}</h2>
        <p className="text-sm text-muted-foreground">{T.variablesHint}</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {variables.map((name) => (
            <li key={name}>
              <code>{`{{${name}}}`}</code>
              <span className="text-muted-foreground"> {T.variableLabels[name]}</span>
            </li>
          ))}
        </ul>
      </section>

      <div role="group" aria-label={T.languageGroup} className="flex gap-2">
        {LANGUAGES.map((item) => (
          <Button
            key={item}
            type="button"
            variant={item === language ? "default" : "outline"}
            aria-pressed={item === language}
            onClick={() => setLanguage(item)}
          >
            {T.languages[item]}
          </Button>
        ))}
      </div>

      {templates
        .filter((template) => template.language === language)
        .map((template) => (
          <TemplateCard key={`${template.kind}-${template.language}`} template={template} />
        ))}
    </div>
  );
}
