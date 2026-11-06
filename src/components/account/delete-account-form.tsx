"use client";

import { useState, useTransition, type FormEvent } from "react";
import { deleteOwnAccountAction } from "@/app/(app)/nastaveni/ucet/actions";
import { createBackupAction } from "@/app/(app)/nastaveni/zaloha/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TEXTS } from "@/lib/texts";

const O = TEXTS.backup.deleteOffer;

export type BackupOffer = { lastBackupAt: string | null; running: boolean };

// ADM-009: deleting never waits for a backup, it only offers one and says the file goes too.
function BackupOfferBox({ offer }: { offer: BackupOffer }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(offer.running);

  function create() {
    startTransition(async () => {
      const reply = await createBackupAction();
      setMessage(reply.ok ? O.started : reply.error);
      if (reply.ok) setRunning(true);
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-testid="backup-offer">
      <p>{offer.lastBackupAt ? O.last(offer.lastBackupAt) : O.none}</p>
      {running && <p>{O.running}</p>}
      <p className="text-muted-foreground">{O.warning}</p>
      {message && <p role="status">{message}</p>}
      <div>
        <Button type="button" variant="outline" onClick={create} disabled={pending || running}>
          {O.create}
        </Button>
      </div>
    </div>
  );
}

export function DeleteAccountForm({
  hasPassword,
  backup,
}: {
  hasPassword: boolean;
  backup: BackupOffer;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    startTransition(async () => {
      const result = await deleteOwnAccountAction({
        password: typeof password === "string" ? password : undefined,
      });
      setError(result.error);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 sm:max-w-md">
      <p className="text-sm text-muted-foreground">
        Smažou se všechna vaše data a nejde to vrátit. Než budete pokračovat, stáhněte si zálohu.
      </p>
      <BackupOfferBox offer={backup} />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {hasPassword ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="delete-password">Heslo</Label>
          <Input
            id="delete-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Účet nemá heslo, smazání proto vyžaduje přihlášení za posledních 15 minut.
        </p>
      )}
      <Button type="submit" variant="destructive" disabled={pending}>
        Smazat můj účet
      </Button>
    </form>
  );
}
