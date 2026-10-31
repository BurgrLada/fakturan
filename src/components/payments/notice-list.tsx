"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useTransition } from "react";
import {
  dismissNoticeAction,
  restoreNoticeAction,
  undoNoticeAction,
} from "@/app/(app)/platby/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Currency } from "@/lib/currency";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.bankQueue;
const TOUCH = "max-sm:h-11 max-sm:min-w-11";

export type NoticeItem = {
  id: string;
  status: "matched" | "pending" | "ignored" | "unrecognized" | "dismissed";
  reason: string | null;
  provisional: boolean;
  paidOn: string | null;
  paidTime: string | null;
  amountMinor: number | null;
  currency: Currency | null;
  variableSymbol: string | null;
  counterpartyName: string | null;
  counterpartyMasked: string | null;
  message: string | null;
  accountMasked: string | null;
  receivedAt: string;
  purged: boolean;
  invoices: { id: string; number: string | null }[];
};

type Reply = { ok: true } | { ok: false; error: string; expired?: true };

export function useNoticeRunner() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(work: () => Promise<Reply>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const reply = await work();
        if (reply.ok) {
          after?.();
          router.refresh();
        } else {
          setError(reply.expired ? T.errors.expired : reply.error);
        }
      } catch {
        setError(T.errors.failed);
      }
    });
  }
  return { pending, error, run };
}

export function ProvisionalBadge() {
  return (
    <Badge variant="outline" data-testid="provisional-badge" title={T.provisionalHint}>
      {T.provisional}
    </Badge>
  );
}

export function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  return (T.reasons as Record<string, string>)[reason] ?? null;
}

export function NoticeSummary({ item }: { item: NoticeItem }) {
  const S = T.row;
  const recognized = item.amountMinor !== null && item.currency !== null;
  const reason = reasonText(item.reason);
  const counterparty = item.counterpartyName ?? item.counterpartyMasked;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {recognized ? (
          <span className="font-medium" data-testid="notice-amount">
            {formatMoney(item.amountMinor!, item.currency!)}
          </span>
        ) : (
          <span className="font-medium">{T.unrecognized.noPayment}</span>
        )}
        {item.provisional && <ProvisionalBadge />}
        <Badge variant="secondary">{T.statuses[item.status]}</Badge>
      </div>
      {recognized ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {item.paidOn && (
            <>
              <dt>{S.date}</dt>
              <dd>
                {formatCalendarDate(item.paidOn, "d. M. yyyy")}
                {item.paidTime && ` ${item.paidTime}`}
              </dd>
            </>
          )}
          {item.variableSymbol && (
            <>
              <dt>{S.symbol}</dt>
              <dd>{item.variableSymbol}</dd>
            </>
          )}
          {counterparty && (
            <>
              <dt>{S.counterparty}</dt>
              <dd className="break-words">{counterparty}</dd>
            </>
          )}
          {item.message && (
            <>
              <dt>{S.message}</dt>
              <dd className="break-words">{item.message}</dd>
            </>
          )}
          {item.accountMasked && (
            <>
              <dt>{S.account}</dt>
              <dd>{item.accountMasked}</dd>
            </>
          )}
          {item.invoices.length > 0 && (
            <>
              <dt>{S.invoices}</dt>
              <dd>
                {item.invoices.map((invoice, index) => (
                  <span key={invoice.id}>
                    {index > 0 && ", "}
                    <Link href={`/faktury/${invoice.id}`} className="underline">
                      {invoice.number ?? invoice.id}
                    </Link>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">
          {S.received}: {formatDateTime(new Date(item.receivedAt))}
        </p>
      )}
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      {item.purged && <p className="text-xs text-muted-foreground">{S.purged}</p>}
    </div>
  );
}

type Confirm = { kind: "dismiss" | "undo"; item: NoticeItem };

export function DismissUndoDialog({
  confirm,
  onClose,
  onConfirm,
  pending,
}: {
  confirm: Confirm | null;
  onClose: () => void;
  onConfirm: (confirm: Confirm) => void;
  pending: boolean;
}) {
  const copy = confirm?.kind === "undo" ? T.undo : T.dismiss;
  return (
    <AlertDialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
          {confirm?.kind === "undo" && (
            <p className="text-sm text-muted-foreground" data-testid="undo-warning">
              {T.undo.sentWarning}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T.actions.back}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => confirm && onConfirm(confirm)}
          >
            {copy.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function NoticeList({
  rows,
  mode,
  label,
}: {
  rows: NoticeItem[];
  mode: "unrecognized" | "history";
  label: string;
}) {
  const { pending, error, run } = useNoticeRunner();
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  function perform({ kind, item }: Confirm) {
    setConfirm(null);
    run(() =>
      kind === "undo" ? undoNoticeAction({ id: item.id }) : dismissNoticeAction({ id: item.id }),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={label} className="flex flex-col gap-2">
        {rows.map((item) => (
          <li
            key={item.id}
            id={`avizo-${item.id}`}
            data-testid="notice-row"
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
          >
            <NoticeSummary item={item} />
            <span className="flex items-center gap-1">
              {mode === "unrecognized" && (
                <Button
                  variant="outline"
                  size="sm"
                  className={TOUCH}
                  disabled={pending}
                  onClick={() => setConfirm({ kind: "dismiss", item })}
                >
                  {T.actions.dismiss}
                </Button>
              )}
              {mode === "history" && item.status === "matched" && (
                <Button
                  variant="outline"
                  size="sm"
                  className={TOUCH}
                  disabled={pending}
                  onClick={() => setConfirm({ kind: "undo", item })}
                >
                  {T.actions.undo}
                </Button>
              )}
              {mode === "history" && item.status === "dismissed" && (
                <Button
                  variant="outline"
                  size="sm"
                  className={TOUCH}
                  disabled={pending}
                  onClick={() => run(() => restoreNoticeAction({ id: item.id }))}
                >
                  {T.actions.restore}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DismissUndoDialog
        confirm={confirm}
        pending={pending}
        onClose={() => setConfirm(null)}
        onConfirm={perform}
      />
    </div>
  );
}
