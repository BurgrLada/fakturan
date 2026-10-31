"use client";

import { useTransition } from "react";
import { markAllReadAction, markReadAction } from "@/app/(app)/upozorneni/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { NotificationKind, NotificationParams } from "@/lib/automation";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.notifications;

export type NotificationRow = {
  id: string;
  kind: NotificationKind;
  params: NotificationParams;
  createdAt: string | null;
  read: boolean;
  resolved: boolean;
};

export function notificationText(kind: NotificationKind, params: NotificationParams): string {
  return T.kinds[kind](params);
}

export function NotificationList({
  rows,
  canMarkAll,
}: {
  rows: NotificationRow[];
  canMarkAll: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      {canMarkAll && (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(() => markAllReadAction())}
          >
            {T.markAll}
          </Button>
        </div>
      )}
      <ul aria-label={T.list} className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className={row.read || row.resolved ? "text-sm text-muted-foreground" : "text-sm"}>
                {notificationText(row.kind, row.params)}
              </p>
              {row.createdAt && (
                <time dateTime={row.createdAt} className="text-xs text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" })}
                </time>
              )}
            </div>
            {row.resolved && <Badge variant="outline">{T.resolved}</Badge>}
            {!row.read && !row.resolved && <Badge>{T.unread}</Badge>}
            {!row.read && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => startTransition(() => markReadAction(row.id))}
              >
                {T.markRead}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
