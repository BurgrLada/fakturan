"use client";

import Link from "next/link";
import { useState } from "react";
import { checkMailboxNowAction } from "@/app/(app)/platby/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import type { BankFailureCode } from "@/lib/bank-mailbox";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import { useNoticeRunner } from "./notice-list";

const T = TEXTS.bankQueue.status;

export type BankStatusView = {
  enabled: boolean;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastNoticeAt: string | null;
  failureCode: BankFailureCode | null;
  failures: number;
} | null;

const when = (value: string | null) => (value ? formatDateTime(new Date(value)) : T.never);

export function BankStatus({ status }: { status: BankStatusView }) {
  const { pending, error, run } = useNoticeRunner();
  const [queued, setQueued] = useState(false);

  if (!status) {
    return (
      <section
        aria-label={T.title}
        data-testid="bank-status"
        className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-4 text-sm"
      >
        <p>{T.none}</p>
        <Link
          href="/nastaveni/aviza"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {T.setup}
        </Link>
      </section>
    );
  }
  const failing = status.failureCode !== null;
  return (
    <section
      aria-label={T.title}
      data-testid="bank-status"
      className="flex flex-col gap-2 rounded-lg border p-4 text-sm"
    >
      <h2 className="text-base">{T.title}</h2>
      <p role="status" data-tone={failing ? "warning" : undefined}>
        {!status.enabled ? T.off : failing ? T.failing : T.ok}
        {failing && ` ${TEXTS.bankMailbox.failure[status.failureCode!]}`}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <dt>{T.lastCheck}</dt>
        <dd>{when(status.lastCheckAt)}</dd>
        <dt>{T.lastSuccess}</dt>
        <dd>{when(status.lastSuccessAt)}</dd>
        <dt>{T.lastNotice}</dt>
        <dd>{when(status.lastNoticeAt)}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="max-sm:h-11"
          disabled={pending || !status.enabled}
          onClick={() => {
            setQueued(false);
            run(
              () => checkMailboxNowAction({ requestId: crypto.randomUUID() }),
              () => setQueued(true),
            );
          }}
        >
          {T.check}
        </Button>
        <Link href="/nastaveni/aviza" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          {T.settings}
        </Link>
      </div>
      {queued && !error && (
        <Alert role="status">
          <AlertDescription>{T.checkQueued}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
