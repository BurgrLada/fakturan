"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { dismissNoticeAction } from "@/app/(app)/platby/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { NoticeAssignDialog } from "./notice-assign-dialog";
import { DismissUndoDialog, NoticeSummary, useNoticeRunner, type NoticeItem } from "./notice-list";
import { NoticeSplitDialog } from "./notice-split-dialog";

const T = TEXTS.bankQueue;
const TOUCH = "max-sm:h-11 max-sm:min-w-11";

export function NoticeQueue({
  rows,
  total,
  receipts,
}: {
  rows: NoticeItem[];
  total: number;
  receipts: boolean;
}) {
  const router = useRouter();
  const { pending, error, run } = useNoticeRunner();
  const [assigning, setAssigning] = useState<NoticeItem | null>(null);
  const [splitting, setSplitting] = useState<NoticeItem | null>(null);
  const [dismissing, setDismissing] = useState<NoticeItem | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{T.queue.empty}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={T.queue.list} className="flex flex-col gap-2">
        {rows.map((item) => (
          <li
            key={item.id}
            id={`avizo-${item.id}`}
            data-testid="notice-row"
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
          >
            <NoticeSummary item={item} />
            <span className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                className={TOUCH}
                disabled={pending}
                onClick={() => setAssigning(item)}
              >
                {T.actions.assign}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={TOUCH}
                disabled={pending}
                onClick={() => setSplitting(item)}
              >
                {T.actions.split}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={TOUCH}
                disabled={pending}
                onClick={() => setDismissing(item)}
              >
                {T.actions.dismiss}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {total > rows.length && (
        <p className="text-sm text-muted-foreground" data-testid="queue-truncated">
          {T.queue.truncated(rows.length, total)}
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <NoticeAssignDialog
        notice={assigning}
        receipts={receipts}
        onClose={() => setAssigning(null)}
        onDone={() => {
          setAssigning(null);
          router.refresh();
        }}
      />
      <NoticeSplitDialog
        notice={splitting}
        receipts={receipts}
        onClose={() => setSplitting(null)}
        onDone={() => {
          setSplitting(null);
          router.refresh();
        }}
      />
      <DismissUndoDialog
        confirm={dismissing && { kind: "dismiss", item: dismissing }}
        pending={pending}
        onClose={() => setDismissing(null)}
        onConfirm={({ item }) => {
          setDismissing(null);
          run(() => dismissNoticeAction({ id: item.id }));
        }}
      />
    </div>
  );
}
