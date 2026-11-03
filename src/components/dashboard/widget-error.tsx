"use client";

import { catchError, type ErrorInfo } from "next/error";
import { TEXTS } from "@/lib/texts";

const V = TEXTS.dashboard.view;

export function WidgetErrorMessage() {
  return (
    <div role="alert" data-testid="widget-error" className="space-y-1 text-sm">
      <p className="font-medium">{V.broken}</p>
      <p className="text-muted-foreground">{V.brokenBody}</p>
    </div>
  );
}

function Fallback(_props: object, _info: ErrorInfo) {
  return <WidgetErrorMessage />;
}

// One card failing while rendering in the browser leaves the other cards alone.
export const WidgetErrorBoundary = catchError(Fallback);
