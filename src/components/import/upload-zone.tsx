"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createImportBatchAction, startParseAction } from "@/app/(app)/nastaveni/import/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MAX_UPLOAD_BYTES } from "@/lib/import-preview";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.importing;

async function upload(batchId: string, file: File): Promise<string | null> {
  const response = await fetch(`/nastaveni/import/nahrani?davka=${batchId}`, {
    method: "POST",
    headers: { "x-file-name": encodeURIComponent(file.name) },
    body: file,
  });
  if (response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? T.upload.failed;
}

export function UploadZone() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (files.length === 0) return setError(T.errors.empty);
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
      return setError(T.errors.tooLarge);
    }
    const created = await createImportBatchAction();
    if (!created.ok) return setError(created.error);
    for (const [index, file] of files.entries()) {
      setBusy(T.upload.uploading(index + 1, files.length));
      const failed = await upload(created.id, file);
      if (failed) {
        setBusy(null);
        return setError(failed);
      }
    }
    const started = await startParseAction({ batchId: created.id });
    setBusy(null);
    if (!started.ok) return setError(started.error);
    router.push(`/nastaveni/import/${created.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <Label htmlFor="import-files">{T.upload.label}</Label>
        <input
          id="import-files"
          type="file"
          multiple
          accept=".isdoc,.isdocx,.xml,.zip,.pdf"
          className="block w-full text-sm"
          onChange={(event) => setFiles([...(event.target.files ?? [])])}
        />
        <p className="text-xs text-muted-foreground">{T.upload.hint}</p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={busy !== null}>
        {busy ?? T.upload.start}
      </Button>
    </form>
  );
}
