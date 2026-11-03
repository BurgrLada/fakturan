"use client";

import { Download } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const S = TEXTS.dashboard.share;

function filenameOf(response: Response, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  return match?.[1] ?? fallback;
}

// Fetched rather than a form post, so a refusal shows here and the editor with unsaved changes
// stays on screen.
export function ExportButton({
  href,
  label,
  ariaLabel,
  size,
}: {
  href: string;
  label: string;
  ariaLabel?: string;
  size?: "sm";
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(href, { method: "POST" });
        if (!response.ok) {
          setError((await response.text()) || S.exportFailed);
          return;
        }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = filenameOf(response, "fakturan.json");
        link.click();
        URL.revokeObjectURL(url);
      } catch {
        setError(S.exportFailed);
      }
    });
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={ariaLabel}
        disabled={pending}
        onClick={run}
      >
        <Download aria-hidden />
        {label}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
