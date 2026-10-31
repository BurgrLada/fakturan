"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { acknowledgeUnknownAction } from "@/app/(app)/faktury/actions";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import type { EmailLogRow } from "@/server/services/invoice-mail";
import { SendDialog } from "./send-dialog";

const T = TEXTS.invoiceMail;
const REFRESH_MS = 2_000;
const RETRY_REFRESH_MS = 30_000;

// Delivery happens in the worker, so nothing else tells this page that a message left.
function RefreshWhileSending({ sending, retrying }: { sending: boolean; retrying: boolean }) {
  const router = useRouter();
  const every = retrying ? RETRY_REFRESH_MS : REFRESH_MS;
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, every);
    return () => clearInterval(timer);
  }, [router, sending, every]);
  return null;
}

export function EmailHistory({
  invoiceId,
  rows,
  sending,
  retrying,
  canResend,
}: {
  invoiceId: string;
  rows: EmailLogRow[];
  sending: boolean;
  retrying: boolean;
  canResend: boolean;
}) {
  const router = useRouter();
  const [resending, setResending] = useState<string | null>(null);
  const [acknowledging, startAcknowledging] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  function acknowledge(id: string) {
    setFailure(null);
    startAcknowledging(async () => {
      const reply = await acknowledgeUnknownAction({ id }).catch(() => null);
      if (reply?.ok) router.refresh();
      else setFailure(reply?.error ?? T.history.acknowledgeFailed);
    });
  }

  return (
    <>
      <RefreshWhileSending sending={sending} retrying={retrying} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.history.empty}</p>
      ) : (
        <ul
          data-testid="email-history"
          className="flex flex-col divide-y rounded-md border text-sm"
        >
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 p-2">
              <div className="flex flex-wrap justify-between gap-x-4">
                <span className="font-medium">{T.statuses[row.status]}</span>
                <time
                  dateTime={(row.sentAt ?? row.createdAt).toISOString()}
                  className="text-muted-foreground"
                >
                  {formatDateTime(row.sentAt ?? row.createdAt)}
                </time>
              </div>
              <p className="break-words">
                <span className="text-muted-foreground">{T.history.to}: </span>
                {row.to.join(", ")}
              </p>
              <p className="break-words">
                <span className="text-muted-foreground">{T.history.subject}: </span>
                {row.subject}
              </p>
              {row.reason && <p className="text-muted-foreground">{row.reason}</p>}
              <div className="flex flex-wrap gap-3">
                {row.hasArchive && (
                  <a
                    href={`/faktury/${invoiceId}/odeslani/${row.id}`}
                    className="underline underline-offset-4"
                  >
                    {T.history.archive}
                  </a>
                )}
                {row.resendable && canResend && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={sending}
                    onClick={() => setResending(row.id)}
                  >
                    {row.status === "unknown" ? T.detail.manualSend : T.detail.resend}
                  </Button>
                )}
                {row.acknowledgeable && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={acknowledging}
                    onClick={() => acknowledge(row.id)}
                  >
                    {T.history.acknowledge}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <SendDialog
        invoiceId={invoiceId}
        logId={resending ?? undefined}
        open={resending !== null}
        onClose={() => setResending(null)}
        onSent={() => {
          setResending(null);
          router.refresh();
        }}
      />
    </>
  );
}
