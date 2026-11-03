import { Suspense, type CSSProperties } from "react";
import { TEXTS } from "@/lib/texts";
import type { DashboardWidgetView } from "@/server/services/dashboards";
import { WidgetBody, type WidgetEnv } from "./widget-body";
import { WidgetErrorBoundary, WidgetErrorMessage } from "./widget-error";
import { widgetTitle } from "./widget-view";

const V = TEXTS.dashboard.view;

function WidgetLoading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {V.loading}
    </p>
  );
}

// From md the card takes its box of the 12-column grid; below it the cards stack in DOM order,
// which is y then x (DSH-004).
export function WidgetCard({ widget, env }: { widget: DashboardWidgetView; env: WidgetEnv }) {
  const titleId = `widget-${widget.id}-title`;
  const box = {
    "--x": widget.x + 1,
    "--y": widget.y + 1,
    "--w": widget.w,
    "--h": widget.h,
  } as CSSProperties;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="widget"
      data-widget-id={widget.id}
      style={box}
      className="flex min-w-0 flex-col gap-2 rounded-lg border p-4 md:[grid-column:var(--x)/span_var(--w)] md:[grid-row:var(--y)/span_var(--h)]"
    >
      <h2 id={titleId} className="text-base font-medium">
        {widgetTitle(widget.config)}
      </h2>
      {widget.config ? (
        <WidgetErrorBoundary>
          <Suspense fallback={<WidgetLoading />}>
            <WidgetBody
              config={widget.config}
              title={widgetTitle(widget.config)}
              h={widget.h}
              env={env}
            />
          </Suspense>
        </WidgetErrorBoundary>
      ) : (
        <WidgetErrorMessage />
      )}
    </section>
  );
}
