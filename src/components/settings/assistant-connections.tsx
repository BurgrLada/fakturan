"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { disconnectMcpClientAction } from "@/app/(app)/nastaveni/asistenti/actions";
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

const T = TEXTS.mcp.connections;

export type ConnectionRow = {
  clientId: string;
  name: string;
  host: string;
  connectedAt: string;
  lastUsedAt: string | null;
};

function DisconnectButton({
  row,
  disabled,
  onConfirm,
}: {
  row: ConnectionRow;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
        {T.disconnect}
        <span className="sr-only"> {row.name}</span>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.confirmTitle(row.name)}</AlertDialogTitle>
          <AlertDialogDescription>{T.confirmBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {T.confirmAction}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AssistantConnections({ connections }: { connections: ConnectionRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function disconnect(clientId: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await disconnectMcpClientAction(clientId);
      setMessage(result.ok ? { ok: true, text: T.done } : { ok: false, text: result.error });
      if (result.ok) router.refresh();
    });
  }

  return (
    <section
      aria-labelledby="mcp-connections"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 id="mcp-connections" className="text-lg">
        {T.title}
      </h2>
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.empty}</p>
      ) : (
        <ul aria-label={T.listLabel} className="flex flex-col divide-y">
          {connections.map((row) => (
            <li
              key={row.clientId}
              className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="break-words font-medium">{row.name}</span>
                <span className="text-sm text-muted-foreground">
                  {row.host}
                  <span aria-hidden> · </span>
                  {T.connected(row.connectedAt)}
                  <span aria-hidden> · </span>
                  {row.lastUsedAt ? T.lastUsed(row.lastUsedAt) : T.neverUsed}
                </span>
              </div>
              <DisconnectButton
                row={row}
                disabled={pending}
                onConfirm={() => disconnect(row.clientId)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
