"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { revokeOtherSessionsAction, revokeSessionAction } from "@/app/(app)/nastaveni/ucet/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

export type SessionRow = {
  id: string;
  current: boolean;
  device: string;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
};

export function SessionList({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const others = sessions.filter((row) => !row.current);

  function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work();
      setMessage(
        result.ok
          ? { ok: true, text: TEXTS.sessions.revoked }
          : { ok: false, text: result.error || TEXTS.sessions.failed },
      );
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 sm:max-w-xl">
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <ul className="flex flex-col divide-y rounded-md border">
        {sessions.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 break-all">
                {row.device}
                {row.current && <Badge>{TEXTS.sessions.current}</Badge>}
              </span>
              <span className="text-xs text-muted-foreground">
                {[
                  row.ip,
                  `${TEXTS.sessions.started}: ${row.createdAt}`,
                  `${TEXTS.sessions.expires}: ${row.expiresAt}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {!row.current && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`${TEXTS.sessions.revoke} relaci ${row.device}`}
                onClick={() => run(() => revokeSessionAction({ id: row.id }))}
              >
                {TEXTS.sessions.revoke}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={pending || others.length === 0}
          onClick={() => run(revokeOtherSessionsAction)}
        >
          {TEXTS.sessions.revokeOthers}
        </Button>
      </div>
    </div>
  );
}
