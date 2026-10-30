"use client";

import { useState, useTransition } from "react";
import { archiveCatalogItemAction, restoreCatalogItemAction } from "@/app/(app)/cenik/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.catalog;

export function CatalogActions({ id, archived }: { id: string; archived: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    startTransition(async () => {
      const result = await (archived ? restoreCatalogItemAction : archiveCatalogItemAction)({ id });
      setError(result.ok ? null : result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="outline" disabled={pending} onClick={toggle}>
          {archived ? T.restore : T.archive}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
