"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { discardBatchAction } from "@/app/(app)/nastaveni/import/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.importing.discard;

export function DiscardBatch({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const discard = () =>
    startTransition(async () => {
      const result = await discardBatchAction({ batchId });
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.push("/nastaveni/import");
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(true)}>
        {T.action}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.title}</AlertDialogTitle>
            <AlertDialogDescription>{T.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <Button variant="destructive" disabled={pending} onClick={discard}>
              {T.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
