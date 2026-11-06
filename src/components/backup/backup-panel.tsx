"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { backupListAction, createBackupAction } from "@/app/(app)/nastaveni/zaloha/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import type { BackupListRow } from "@/server/services/exports";

const T = TEXTS.backup;
const X = TEXTS.exporting;
const POLL_MS = 1500;
const RUNNING = new Set<BackupListRow["status"]>(["queued", "running"]);

export function BackupPanel({ initial }: { initial: BackupListRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const running = rows.some((row) => RUNNING.has(row.status));

  useEffect(() => setRows(initial), [initial]);

  useEffect(() => {
    if (!running) return;
    let current = true;
    const timer = setInterval(() => {
      backupListAction().then(
        (reply) => {
          if (current && reply.ok) setRows(reply.rows);
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [running]);

  function start() {
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await createBackupAction();
        if (!reply.ok) return setMessage({ ok: false, text: reply.error });
        setMessage({ ok: true, text: T.started });
        router.refresh();
      } catch {
        setMessage({ ok: false, text: T.failed });
      }
    });
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {message && (
          <Alert
            variant={message.ok ? "default" : "destructive"}
            role={message.ok ? "status" : "alert"}
          >
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="button" onClick={start} disabled={pending || running}>
            {T.start}
          </Button>
        </div>
      </div>
      <h2 className="text-lg font-medium">{T.list.title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{T.list.empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm" aria-label={T.list.title}>
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="backup-row"
              className="flex flex-wrap items-center justify-between gap-2 p-3"
            >
              <span className="flex flex-col gap-1">
                <span>
                  {formatDateTime(row.createdAt)} ·{" "}
                  <span data-testid="backup-status">{X.statuses[row.status]}</span>
                  {row.status === "running" &&
                    row.progressTotal > 0 &&
                    ` · ${X.list.progress(row.progress, row.progressTotal)}`}
                </span>
                {row.status === "failed" && row.reason && (
                  <span className="text-destructive">{row.reason}</span>
                )}
              </span>
              {row.downloadable && (
                <span className="flex items-center gap-2">
                  {row.expiresAt && (
                    <span className="text-muted-foreground">
                      {X.list.expires(formatDateTime(row.expiresAt))}
                    </span>
                  )}
                  <a href={`/nastaveni/export/${row.id}`} className="underline underline-offset-4">
                    {X.list.download}
                  </a>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
