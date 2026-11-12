"use client";

import { useState, useTransition } from "react";
import { saveMcpSettingsAction } from "@/app/(app)/nastaveni/asistenti/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MCP_LEVELS, type McpLevel, type McpSettings } from "@/lib/mcp-settings";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.mcp.settings;

type Message = { ok: boolean; text: string } | null;

function CopyAddress({ address }: { address: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code
        aria-label={T.addressLabel}
        className="min-w-0 break-all rounded bg-muted px-2 py-1 text-sm"
      >
        {address}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? T.copied : T.copy}
      </Button>
      {state === "failed" && <span className="text-sm text-destructive">{T.copyFailed}</span>}
    </div>
  );
}

export function AssistantsForm({
  settings,
  address,
  local,
}: {
  settings: McpSettings;
  address: string;
  local: boolean;
}) {
  const [current, setCurrent] = useState(settings);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message>(null);

  // Every change saves at once; the returned revision is the base of the next one.
  function change(patch: Partial<Omit<McpSettings, "revision">>) {
    setMessage(null);
    startTransition(async () => {
      const result = await saveMcpSettingsAction({ ...current, ...patch });
      if (result.ok) {
        setCurrent(result.settings);
        setMessage({ ok: true, text: T.saved });
      } else {
        setMessage({ ok: false, text: result.error });
      }
    });
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

      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <input
            id="mcp-enabled"
            type="checkbox"
            className="size-4 accent-primary"
            checked={current.enabled}
            disabled={pending}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
          <label htmlFor="mcp-enabled" className="text-base font-medium">
            {T.enable}
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{T.enableHint}</p>
        <CopyAddress address={address} />
      </section>

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-lg">{T.guide.title}</h2>
        <p className="text-sm">{T.guide.claudeCode}</p>
        <code className="break-all rounded bg-muted px-2 py-1 text-sm">
          {`claude mcp add --transport http fakturan ${address}`}
        </code>
        <p className="text-sm">{T.guide.claudeWeb}</p>
        <p className="text-sm text-muted-foreground">{T.guide.after}</p>
        {local && <p className="text-sm text-muted-foreground">{T.guide.localhost}</p>}
      </section>

      <section
        aria-labelledby="mcp-capabilities"
        className="flex flex-col gap-3 rounded-lg border p-4"
      >
        <h2 id="mcp-capabilities" className="text-lg">
          {T.capabilitiesTitle}
        </h2>
        {/* Bridge until Task 3 of plan 11 brings the level choice with descriptions. */}
        <select
          aria-label={T.capabilitiesLabel}
          className="w-fit rounded border px-2 py-1 text-sm"
          value={current.level}
          disabled={pending}
          onChange={(event) => change({ level: event.target.value as McpLevel })}
        >
          {MCP_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </section>
    </div>
  );
}
