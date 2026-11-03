"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteImportedAction } from "@/app/(app)/faktury/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.importing.imported;

// An imported document is read-only (IMP-005): its own PDF and deleting it are all there is.
export function ImportedActions({ id, pdfFileId }: { id: string; pdfFileId: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = () =>
    startTransition(async () => {
      if (!window.confirm(T.deleteConfirm)) return;
      const reply = await deleteImportedAction({ id });
      if (!reply.ok) return setError(reply.error);
      router.push("/faktury");
    });

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{T.readOnly}</span>
      {pdfFileId && (
        <a href={`/soubory/${pdfFileId}`} className="underline underline-offset-4" download>
          {TEXTS.importing.originalPdf}
        </a>
      )}
      <Button size="sm" variant="outline" disabled={pending} onClick={remove}>
        {T.delete}
      </Button>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
