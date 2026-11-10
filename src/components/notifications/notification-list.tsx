"use client";

import Link from "next/link";
import { useTransition } from "react";
import { markAllReadAction, markReadAction } from "@/app/(app)/upozorneni/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { NotificationKind, NotificationParams } from "@/lib/automation";
import { notificationTarget, notificationText } from "@/lib/notification-text";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.notifications;

export type NotificationRow = {
  id: string;
  kind: NotificationKind;
  params: NotificationParams;
  entityType: string | null;
  entityId: string | null;
  createdAt: string | null;
  read: boolean;
  resolved: boolean;
};

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
        {rows.map((row) => {
          const target = notificationTarget(row.kind, { type: row.entityType, id: row.entityId });
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p
                  className={row.read || row.resolved ? "text-sm text-muted-foreground" : "text-sm"}
                >
                  {notificationText(row.kind, row.params)}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {row.createdAt && (
                    <time dateTime={row.createdAt}>
                      {new Date(row.createdAt).toLocaleString("cs-CZ", {
                        timeZone: "Europe/Prague",
                      })}
                    </time>
                  )}
                  {target && (
                    <Link
                      href={target.href}
                      onClick={() => {
                        if (!row.read) startTransition(() => markReadAction(row.id));
                      }}
                      className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      {target.label} →
                    </Link>
                  )}
                </div>
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
          );
        })}
      </ul>
    </div>
  );
}
