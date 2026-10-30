"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  archiveCustomerAction,
  deleteCustomerAction,
  restoreCustomerAction,
} from "@/app/(app)/zakaznici/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.customers;

export function CustomerActions({ id, archived }: { id: string; archived: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function perform(work: () => Promise<{ ok: boolean; error?: string }>, leave?: boolean) {
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? T.validation.invalid);
        return;
      }
      setError(null);
      if (leave) router.push("/zakaznici");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {archived ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => perform(() => restoreCustomerAction({ id }))}
          >
            {T.restore}
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => perform(() => archiveCustomerAction({ id }))}
          >
            {T.archive}
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" disabled={pending} />}>
            {T.remove}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{T.removeTitle}</AlertDialogTitle>
              <AlertDialogDescription>{T.removeBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => perform(() => deleteCustomerAction({ id }), true)}
              >
                {T.confirmRemove}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
