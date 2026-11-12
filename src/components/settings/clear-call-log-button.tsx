"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { clearMcpCallLogAction } from "@/app/(app)/nastaveni/asistenti/actions";
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

const T = TEXTS.mcp.callLog;

// „Smazat log“ with a confirmation (MCP-064).
export function ClearCallLogButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function clear() {
    setOpen(false);
    setMessage(null);
    startTransition(async () => {
      const result = await clearMcpCallLogAction();
      setMessage(result.ok ? { ok: true, text: T.cleared } : { ok: false, text: result.error });
      if (result.ok) router.push("/nastaveni/asistenti#mcp-call-log");
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={<Button size="sm" variant="outline" disabled={pending} />}>
          {T.clear}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{T.confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <Button variant="destructive" onClick={clear}>
              {T.confirmAction}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
