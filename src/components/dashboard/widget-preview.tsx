"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { previewWidgetAction } from "@/app/(app)/dashboardy/actions";
import { defaultSize } from "@/lib/dashboard-defaults";
import type { DateFormat } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { czechError, issueText } from "@/lib/validation-issue";
import { widgetConfigSchema, type WidgetConfig } from "@/lib/widget-config";
import type { WidgetResult } from "@/server/reports/widget-query";
import { widgetUnit } from "./widget-number";
import { WidgetErrorBoundary } from "./widget-error";
import { widgetTitle, WidgetView } from "./widget-view";

const T = TEXTS.dashboard.configurator;

export const PREVIEW_DELAY_MS = 300;

type Answer = {
  key: string;
  reply: { ok: true; config: WidgetConfig; result: WidgetResult } | { ok: false; error: string };
};

// DSH-017: the preview follows every change after a short pause, and a ticket drops an answer
// that arrives after a newer request was sent.
export function WidgetPreview({ config, dateFormat }: { config: unknown; dateFormat: DateFormat }) {
  const key = JSON.stringify(config);
  const parsed = useMemo(
    () => widgetConfigSchema.safeParse(JSON.parse(key), { error: czechError }),
    [key],
  );
  const ticket = useRef(0);
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    ticket.current += 1;
    const mine = ticket.current;
    if (!parsed.success) return;
    const checked = parsed.data;
    const timer = setTimeout(async () => {
      let reply: Answer["reply"];
      try {
        const response = await previewWidgetAction({ config: checked });
        reply = response.ok
          ? { ok: true, config: checked, result: response.result }
          : { ok: false, error: response.error };
      } catch {
        reply = { ok: false, error: T.previewFailed };
      }
      if (mine === ticket.current) setAnswer({ key, reply });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, parsed]);

  const busy = parsed.success && answer?.key !== key;
  const shown = answer?.reply;
  return (
    <section
      aria-labelledby="widget-preview-title"
      aria-busy={busy}
      data-testid="widget-preview"
      className="flex min-w-0 flex-col gap-2 rounded-lg border p-4"
    >
      <h2 id="widget-preview-title" className="text-sm text-muted-foreground">
        {T.preview}
      </h2>
      {!parsed.success ? (
        <p role="alert" className="text-sm text-destructive" data-testid="preview-invalid">
          {issueText(parsed.error)}
        </p>
      ) : (
        <>
          <h3 className="text-base font-medium">{widgetTitle(parsed.data)}</h3>
          {shown?.ok === false && (
            <p role="alert" className="text-sm text-destructive">
              {shown.error}
            </p>
          )}
          {shown?.ok && (
            <WidgetErrorBoundary key={answer!.key}>
              <WidgetView
                config={shown.config}
                result={shown.result}
                unit={widgetUnit(shown.config, {})}
                title={widgetTitle(shown.config)}
                h={defaultSize(shown.config).h}
                dateFormat={dateFormat}
              />
            </WidgetErrorBoundary>
          )}
          <p role="status" className="text-xs text-muted-foreground">
            {busy ? T.previewLoading : T.previewNote}
          </p>
        </>
      )}
    </section>
  );
}
