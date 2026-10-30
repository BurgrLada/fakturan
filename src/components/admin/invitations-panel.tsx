"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  createInvitationAction,
  resendInvitationAction,
  revokeInvitationAction,
} from "@/app/(app)/administrace/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InviteLink } from "./invite-link";

export type InvitationRow = { id: string; email: string; expiresAt: string; expired: boolean };

type Link = { url: string; mailSent: boolean };

export function InvitationsPanel({ invitations }: { invitations: InvitationRow[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<Link | null>(null);

  function perform(
    work: () => Promise<
      { ok: true; url?: string; mailSent?: boolean } | { ok: false; error: string }
    >,
  ) {
    startTransition(async () => {
      const result = await work();
      setError(result.ok ? null : result.error);
      if (result.ok && result.url) setLink({ url: result.url, mailSent: Boolean(result.mailSent) });
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email"));
    perform(async () => {
      const result = await createInvitationAction({ email });
      if (result.ok) form.reset();
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:max-w-md">
        <Label htmlFor="invite-email">E-mail pozvaného</Label>
        <div className="flex gap-2">
          <Input id="invite-email" name="email" type="email" required />
          <Button type="submit" disabled={pending}>
            Pozvat
          </Button>
        </div>
      </form>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {link && <InviteLink {...link} />}
      {invitations.length === 0 ? (
        <p className="text-sm text-muted-foreground">Žádné čekající pozvánky.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>E-mail</TableHead>
              <TableHead>Platí do</TableHead>
              <TableHead>Akce</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.email}</TableCell>
                <TableCell>
                  {row.expired ? <Badge variant="secondary">Vypršela</Badge> : row.expiresAt}
                </TableCell>
                <TableCell className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => perform(() => resendInvitationAction({ id: row.id }))}
                  >
                    Znovu odeslat
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => perform(() => revokeInvitationAction({ id: row.id }))}
                  >
                    Zrušit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
