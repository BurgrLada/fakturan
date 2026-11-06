"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { restoreStateAction } from "@/app/(app)/nastaveni/zaloha/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import type { BackupListRow } from "@/server/services/exports";

const T = TEXTS.restore;
const X = TEXTS.exporting;
const POLL_MS = 1500;
const RUNNING = new Set<BackupListRow["status"]>(["queued", "running"]);

// Sent as the raw body: a server action would buffer it under its 3 MB limit (R-35).
async function upload(file: File): Promise<string | null> {
  const response = await fetch("/nastaveni/zaloha/nahrani", { method: "POST", body: file });
  if (response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? T.failed;
}

export function RestorePanel({ initial }: { initial: BackupListRow | null }) {
  const router = useRouter();
  const [restore, setRestore] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const running = restore !== null && RUNNING.has(restore.status);

  useEffect(() => setRestore(initial), [initial]);

  useEffect(() => {
    if (!running) return;
    let current = true;
    const timer = setInterval(() => {
      restoreStateAction().then(
        (reply) => {
          if (!current || !reply.ok) return;
          setRestore(reply.restore);
          if (reply.restore && !RUNNING.has(reply.restore.status)) router.refresh();
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [running, router]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen = new FormData(event.currentTarget).get("backup");
    if (!(chosen instanceof File) || chosen.size === 0) return setError(T.errors.empty);
    setError(null);
    startTransition(async () => {
      try {
        const problem = await upload(chosen);
        if (problem) return setError(problem);
        const reply = await restoreStateAction();
        if (reply.ok) setRestore(reply.restore);
      } catch {
        setError(T.failed);
      }
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{T.title}</h2>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:max-w-md">
        <div className="flex flex-col gap-1">
          <Label htmlFor="restore-file">{T.file}</Label>
          <Input id="restore-file" name="backup" type="file" accept=".zip,application/zip" />
        </div>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" disabled={pending || running}>
            {pending ? T.uploading : T.start}
          </Button>
        </div>
      </form>
      {restore && (
        <p className="text-sm" data-testid="restore-state">
          {T.status}: {formatDateTime(restore.createdAt)} ·{" "}
          <span data-testid="restore-status">{X.statuses[restore.status]}</span>
          {restore.status === "running" &&
            restore.progressTotal > 0 &&
            ` · ${X.list.progress(restore.progress, restore.progressTotal)}`}
          {restore.status === "done" && ` · ${T.done}`}
          {restore.status === "failed" && restore.reason && (
            <span className="block text-destructive">{restore.reason}</span>
          )}
        </p>
      )}
    </section>
  );
}
