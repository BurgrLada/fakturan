"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import type { EmailLogRow } from "@/server/services/invoice-mail";
import { SendDialog } from "./send-dialog";

const T = TEXTS.invoiceMail;
const REFRESH_MS = 2_000;

// Delivery happens in the worker, so nothing else tells this page that a message left.
function RefreshWhileSending({ sending }: { sending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router, sending]);
  return null;
}

export function EmailHistory({
  invoiceId,
  rows,
  sending,
  canResend,
}: {
  invoiceId: string;
  rows: EmailLogRow[];
  sending: boolean;
  canResend: boolean;
}) {
  const router = useRouter();
  const [resending, setResending] = useState<string | null>(null);

  return (
    <>
      <RefreshWhileSending sending={sending} />
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
              </div>
            </li>
          ))}
        </ul>
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
