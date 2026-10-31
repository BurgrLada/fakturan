"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  setPartialRemindersAction,
  setRemindersOffAction,
  snoozeRemindersAction,
} from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import type { CalendarDate } from "@/lib/number-format";
import { MANUAL_STAGE, stageLabel, type ReminderRule } from "@/lib/reminders";
import type { EmailStatus } from "@/lib/mail-send";
import type { DateFormat } from "@/lib/preferences";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { SendDialog, type ReminderChoice } from "./send-dialog";

const T = TEXTS.reminders.panel;

type Reply = { ok: boolean; error?: string };

export function ReminderPanel({
  invoiceId,
  rules,
  history,
  suggestedStage,
  dateFormat,
  snoozeUntil,
  off,
  partial,
  today,
  latestSnooze,
  canSend,
  sent,
}: {
  invoiceId: string;
  rules: ReminderRule[];
  history: {
    id: string;
    offsetDays: number | null;
    trigger: string;
    createdAt: Date;
    status: EmailStatus | null;
  }[];
  suggestedStage: string | null;
  dateFormat: DateFormat;
  snoozeUntil: CalendarDate | null;
  off: boolean;
  partial: boolean;
  today: CalendarDate;
  latestSnooze: CalendarDate;
  canSend: boolean;
  sent: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState(suggestedStage ?? MANUAL_STAGE);
  const [sending, setSending] = useState<ReminderChoice | null>(null);
  const [until, setUntil] = useState(snoozeUntil ?? "");

  function perform(work: () => Promise<Reply>) {
    setError(null);
    startTransition(async () => {
      try {
        const reply = await work();
        if (!reply.ok) setError(reply.error ?? T.failed);
      } catch {
        setError(T.failed);
      }
    });
  }

  return (
    <section aria-labelledby="reminders-title" className="flex flex-col gap-3 sm:max-w-xl">
      <h2 id="reminders-title" className="text-lg">
        {T.title}
      </h2>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="reminder-stage">{T.stage}</Label>
          <select
            id="reminder-stage"
            value={stage}
            onChange={(event) => setStage(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value={MANUAL_STAGE}>{T.manualStage}</option>
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {stageLabel(rule.offsetDays)}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          disabled={!canSend || !sent}
          aria-describedby={sent ? undefined : "reminder-unsent"}
          onClick={() => setSending({ stageKey: stage === MANUAL_STAGE ? null : stage })}
        >
          {T.send}
        </Button>
      </div>
      {!sent && (
        <p id="reminder-unsent" className="text-sm text-muted-foreground">
          {T.unsent}
        </p>
      )}
      <SendDialog
        invoiceId={invoiceId}
        reminder={sending ?? undefined}
        open={sending !== null}
        onClose={() => setSending(null)}
        onSent={() => {
          setSending(null);
          router.refresh();
        }}
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="reminder-snooze">{T.snooze}</Label>
          <Input
            id="reminder-snooze"
            type="date"
            min={today}
            max={latestSnooze}
            value={until}
            aria-describedby="reminder-snooze-hint"
            onChange={(event) => setUntil(event.target.value)}
            className="w-44"
          />
        </div>
        <Button
          variant="outline"
          disabled={pending || until === ""}
          onClick={() => perform(() => snoozeRemindersAction({ id: invoiceId, until }))}
        >
          {T.snoozeSave}
        </Button>
        {snoozeUntil && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              setUntil("");
              perform(() => snoozeRemindersAction({ id: invoiceId, until: null }));
            }}
          >
            {T.snoozeClear}
          </Button>
        )}
      </div>
      <p id="reminder-snooze-hint" className="text-xs text-muted-foreground">
        {snoozeUntil ? T.snoozed(formatCalendarDate(snoozeUntil, dateFormat)) : T.snoozeHint}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={off}
          disabled={pending}
          onChange={(event) => {
            const on = event.target.checked;
            perform(() => setRemindersOffAction({ id: invoiceId, on }));
          }}
        />
        {T.off}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={partial}
          disabled={pending}
          onChange={(event) => {
            const on = event.target.checked;
            perform(() => setPartialRemindersAction({ id: invoiceId, on }));
          }}
        />
        {T.partial}
      </label>
      <h3 className="text-sm font-medium">{T.sentTitle}</h3>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.none}</p>
      ) : (
        <ul data-testid="reminder-history" className="flex flex-col gap-1 text-sm">
          {history.map((row) => (
            <li key={row.id}>
              {formatDateTime(row.createdAt)} ·{" "}
              {row.offsetDays === null ? T.manualStage : stageLabel(row.offsetDays)} ·{" "}
              {row.trigger === "automatic" ? T.automatic : T.manual}
              {row.status && ` · ${TEXTS.invoiceMail.statuses[row.status]}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
