"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import {
  deleteReminderRuleAction,
  saveReminderRuleAction,
} from "@/app/(app)/nastaveni/automatizace/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, type Language } from "@/lib/preferences";
import { stageLabel, type ReminderRule, type ReminderTexts } from "@/lib/reminders";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { ReviewRow } from "@/server/services/reminders";

const T = TEXTS.reminders.rules;
const V = TEXTS.reminders.review;

type Outcome = { ok: true } | { ok: false; error: string };
type Message = { ok: boolean; text: string } | null;
type Fields = Record<Language, { subject: string; body: string }>;

function fieldsOf(texts: ReminderTexts | null): Fields {
  return {
    cs: { subject: texts?.cs?.subject ?? "", body: texts?.cs?.body ?? "" },
    en: { subject: texts?.en?.subject ?? "", body: texts?.en?.body ?? "" },
  };
}

function textsOf(fields: Fields): ReminderTexts | null {
  const texts: ReminderTexts = {};
  for (const language of LANGUAGES) {
    const { subject, body } = fields[language];
    if (subject.trim() || body.trim()) texts[language] = { subject, body };
  }
  return Object.keys(texts).length > 0 ? texts : null;
}

function RuleForm({
  rule,
  pending,
  onSubmit,
  onCancel,
}: {
  rule: ReminderRule | null;
  pending: boolean;
  onSubmit: (raw: { id?: string; offsetDays: number; texts: ReminderTexts | null }) => void;
  onCancel: () => void;
}) {
  const [offset, setOffset] = useState(String(rule?.offsetDays ?? ""));
  const [fields, setFields] = useState(() => fieldsOf(rule?.texts ?? null));

  function setField(language: Language, field: "subject" | "body", value: string) {
    setFields({ ...fields, [language]: { ...fields[language], [field]: value } });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ ...(rule && { id: rule.id }), offsetDays: Number(offset), texts: textsOf(fields) });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="reminder-offset">{T.offset}</Label>
        <Input
          id="reminder-offset"
          type="number"
          required
          value={offset}
          onChange={(event) => setOffset(event.target.value)}
          className="w-32"
        />
      </div>
      {LANGUAGES.map((language) => (
        <div key={language} className="flex flex-col gap-1">
          <Label htmlFor={`reminder-subject-${language}`}>{T.subject(language)}</Label>
          <Input
            id={`reminder-subject-${language}`}
            value={fields[language].subject}
            onChange={(event) => setField(language, "subject", event.target.value)}
          />
          <Label htmlFor={`reminder-body-${language}`}>{T.text(language)}</Label>
          <Textarea
            id={`reminder-body-${language}`}
            rows={4}
            value={fields[language].body}
            onChange={(event) => setField(language, "body", event.target.value)}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{T.variables}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {T.save}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onCancel}>
          {T.cancel}
        </Button>
      </div>
    </form>
  );
}

export function ReminderRules({ rules }: { rules: ReminderRule[] }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const [editing, setEditing] = useState<ReminderRule | "new" | null>(null);

  function perform(run: () => Promise<Outcome>, success: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await run();
      if (result.ok) setEditing(null);
      setMessage(result.ok ? { ok: true, text: success } : { ok: false, text: result.error });
    });
  }

  return (
    <section aria-labelledby="reminder-rules" className="flex flex-col gap-2 rounded-lg border p-4">
      <h2 id="reminder-rules" className="text-base">
        {T.title}
      </h2>
      <p className="text-sm text-muted-foreground">{T.body}</p>
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      {rules.length === 0 ? (
        <p className="text-sm">{T.empty}</p>
      ) : (
        <ul aria-label={T.list} className="flex flex-col gap-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              data-testid="reminder-rule"
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span>
                {stageLabel(rule.offsetDays)}
                <span className="text-muted-foreground">
                  {" · "}
                  {rule.texts ? T.custom : T.fromTemplate}
                </span>
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setEditing(rule)}
                >
                  {T.edit}
                  <span className="sr-only"> {stageLabel(rule.offsetDays)}</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => perform(() => deleteReminderRuleAction(rule.id), T.removed)}
                >
                  {T.remove}
                  <span className="sr-only"> {stageLabel(rule.offsetDays)}</span>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <RuleForm
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? null : editing}
          pending={pending}
          onSubmit={(raw) => perform(() => saveReminderRuleAction(raw), T.saved)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            {T.add}
          </Button>
        </div>
      )}
    </section>
  );
}

export function ReminderReview({ rows }: { rows: ReviewRow[] }) {
  return (
    <section
      aria-labelledby="reminder-review"
      className="flex flex-col gap-2 rounded-lg border p-4"
    >
      <h2 id="reminder-review" className="text-base">
        {V.title}
      </h2>
      <p className="text-sm text-muted-foreground">{V.body}</p>
      {rows.length === 0 ? (
        <p className="text-sm">{V.empty}</p>
      ) : (
        <ul aria-label={V.list} className="flex flex-col gap-1 text-sm">
          {rows.map((row) => (
            <li
              key={row.invoiceId}
              data-testid="reminder-review-row"
              className="flex flex-wrap gap-x-2"
            >
              <Link href={`/faktury/${row.invoiceId}`} className="underline underline-offset-4">
                {row.number}
              </Link>
              <span>{row.customerName}</span>
              <span>{stageLabel(row.offsetDays)}</span>
              <span className="text-muted-foreground">
                {V.due} {formatCalendarDate(row.dueDate, "d. M. yyyy")}
              </span>
              <span>{formatMoney(row.amountDueMinor, row.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
