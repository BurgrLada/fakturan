"use client";

import { useState, useTransition, type FormEvent } from "react";
import { deleteOwnAccountAction } from "@/app/(app)/nastaveni/ucet/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DeleteAccountForm({ hasPassword }: { hasPassword: boolean }) {
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
