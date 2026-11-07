"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MAX_UPLOAD_BYTES } from "@/lib/import-preview";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.importing.imported;

// IMP-005: the raw file goes to the route, past the server action's body limit.
export function ImportPdfUpload({ id, hasPdf }: { id: string; hasPdf: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(T.pdfTooLarge);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/faktury/${id}/priloha`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? T.attachFailed);
        return;
      }
      router.refresh();
    } catch {
      setError(T.attachFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={chosen}
        data-testid="import-pdf-input"
      />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? T.attaching : hasPdf ? T.replacePdf : T.attachPdf}
      </Button>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
