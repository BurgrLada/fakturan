"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/monitoring-client";
import { TEXTS } from "@/lib/texts";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => reportClientError(error), [error]);
  return (
    <html lang="cs">
      <body>
        <h1>{TEXTS.error.title}</h1>
        <p>{TEXTS.error.body}</p>
        <button type="button" onClick={reset}>
          {TEXTS.error.retry}
        </button>
      </body>
    </html>
  );
}
