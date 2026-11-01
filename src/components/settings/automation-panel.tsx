"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  setAdvanceFinalModeAction,
  setAutomationAction,
  setDailyDigestAction,
  setPausedAction,
  setSendTimeAction,
} from "@/app/(app)/nastaveni/automatizace/actions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { AUTOMATIONS, type AutomationKey, type AutomationSettings } from "@/lib/automation";
import { ADVANCE_FINAL_MODES, type AdvanceFinalMode } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import type { AutomationImpact } from "@/server/services/automation";

const T = TEXTS.automation;

type Outcome = { ok: true } | { ok: false; error: string };
type Message = { ok: boolean; text: string } | null;

function impactText(key: AutomationKey, impact: AutomationImpact): string {
  if (key === "recurringSend") return T.keys.recurringSend.impact(impact.plans);
  if (key === "reminders") return T.keys.reminders.impact(impact.customers);
  if (key === "paymentReceipt") return T.keys.paymentReceipt.impact(impact.addressed);
  return T.keys.advanceInvoice.impact(impact.addressed);
}

function Confirm({
  title,
  body,
  extra,
  action,
  trigger,
  disabled,
  onConfirm,
}: {
  title: string;
  body: string;
  extra?: string;
  action: string;
  trigger: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button size="sm" disabled={disabled} />}>
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {body}
            {extra ? <span className="mt-2 block font-medium">{extra}</span> : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
          <Button
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AutomationPanel({
  settings,
  impact,
  advanceFinalMode,
}: {
  settings: AutomationSettings;
  impact: AutomationImpact;
  advanceFinalMode: AdvanceFinalMode;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const [sendTime, setSendTime] = useState(settings.sendTime);

  function perform(run: () => Promise<Outcome>, success?: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await run();
      setMessage(
        result.ok
          ? success
            ? { ok: true, text: success }
            : null
          : { ok: false, text: result.error },
      );
    });
  }

  function saveTime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    perform(() => setSendTimeAction(sendTime), T.saved);
  }

  return (
    <div className="flex flex-col gap-6">
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <section
        aria-labelledby="automation-master"
        className="flex flex-col gap-2 rounded-lg border p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="automation-master" className="text-lg">
            {T.master.title}
          </h2>
          <Badge variant={settings.paused ? "destructive" : "default"}>
            {settings.paused ? T.master.pausedState : T.master.active}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{T.master.body}</p>
        <div>
          {settings.paused ? (
            <Confirm
              title={T.master.resumeTitle}
              body={T.master.resumeBody}
              action={T.master.resume}
              trigger={T.master.resume}
              disabled={pending}
              onConfirm={() => perform(() => setPausedAction(false, true))}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => perform(() => setPausedAction(true, false))}
            >
              {T.master.pause}
            </Button>
          )}
        </div>
      </section>

      <ul aria-label={T.listLabel} className="flex flex-col gap-3">
        {AUTOMATIONS.map(({ key, available }) => {
          const text = T.keys[key];
          const enabled = settings[key];
          return (
            <li key={key} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base">{text.title}</h2>
                <Badge variant={enabled ? "default" : "outline"}>
                  {available ? (enabled ? T.on : T.off) : T.unavailable}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{text.body}</p>
              {key === "advanceInvoice" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="advance-final-mode">{T.advanceMode.label}</Label>
                  <NativeSelect
                    id="advance-final-mode"
                    value={advanceFinalMode}
                    disabled={pending}
                    onChange={(event) => {
                      const mode = event.target.value;
                      perform(() => setAdvanceFinalModeAction(mode), T.saved);
                    }}
                  >
                    {ADVANCE_FINAL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {T.advanceMode.options[mode]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
              {available && (
                <div>
                  {enabled ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        perform(() =>
                          setAutomationAction({ key, enabled: false, confirmed: false }),
                        )
                      }
                    >
                      {T.disable}
                      <span className="sr-only"> {text.title}</span>
                    </Button>
                  ) : (
                    <Confirm
                      title={T.confirmTitle(text.title)}
                      body={text.body}
                      extra={impactText(key, impact)}
                      action={T.confirmEnable}
                      trigger={T.enable}
                      disabled={pending}
                      onConfirm={() =>
                        perform(() => setAutomationAction({ key, enabled: true, confirmed: true }))
                      }
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form onSubmit={saveTime} className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-base">{T.schedule.title}</h2>
        <p className="text-sm text-muted-foreground">{T.schedule.body}</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="automation-send-time">{T.schedule.label}</Label>
          <Input
            id="automation-send-time"
            type="time"
            required
            value={sendTime}
            onChange={(event) => setSendTime(event.target.value)}
            className="w-32"
          />
        </div>
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {T.schedule.save}
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-base">{T.digest.title}</h2>
        <p className="text-sm text-muted-foreground">{T.digest.body}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.dailyDigest}
            disabled={pending}
            onChange={(event) => perform(() => setDailyDigestAction(event.target.checked))}
          />
          {T.digest.label}
        </label>
      </section>
    </div>
  );
}
