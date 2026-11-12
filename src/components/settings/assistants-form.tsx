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

function McpLevelOption({
  level,
  checked,
  disabled,
  onSelect,
}: {
  level: McpLevel;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { name, description } = TEXTS.mcp.levels[level];
  const id = `mcp-level-${level}`;
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="radio"
        name="mcp-level"
        value={level}
        className="mt-1 size-4 accent-primary"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        onChange={onSelect}
      />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm font-medium">
          {name}
        </label>
        <p id={`${id}-description`} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
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
  // The choice shows at once and goes back if the save fails.
  function change(patch: Partial<Omit<McpSettings, "revision">>) {
    const before = current;
    const next = { ...before, ...patch };
    setMessage(null);
    setCurrent(next);
    startTransition(async () => {
      const result = await saveMcpSettingsAction(next);
      if (result.ok) {
        setCurrent(result.settings);
        setMessage({ ok: true, text: T.saved });
      } else {
        setCurrent(before);
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

      <section aria-labelledby="mcp-level" className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 id="mcp-level" className="text-lg">
          {T.levelTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{T.levelHint}</p>
        {/* One cumulative level per user (MCP-054). */}
        <div role="radiogroup" aria-label={T.levelLabel} className="flex flex-col gap-3">
          {MCP_LEVELS.map((level) => (
            <McpLevelOption
              key={level}
              level={level}
              checked={current.level === level}
              disabled={pending}
              onSelect={() => change({ level })}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <input
            id="mcp-log-calls"
            type="checkbox"
            className="size-4 accent-primary"
            checked={current.logCalls}
            disabled={pending}
            onChange={(event) => change({ logCalls: event.target.checked })}
          />
          <label htmlFor="mcp-log-calls" className="text-base font-medium">
            {T.logCalls}
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{T.logCallsHint}</p>
      </section>
    </div>
  );
}
