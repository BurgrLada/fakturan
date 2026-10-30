"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, authErrorMessage } from "@/lib/auth-client";

export function RegisterForm({ invitedEmail }: { invitedEmail?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [mailSent, setMailSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error: failure } = await authClient.signUp.email({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (failure) {
      setError(authErrorMessage(failure.code));
      return;
    }
    if (!data?.token) {
      setMailSent(true);
      return;
    }
    router.push("/");
    router.refresh();
  }

  if (mailSent) {
    return (
      <Alert>
        <AlertDescription>Na váš e-mail jsme poslali odkaz pro potvrzení účtu.</AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Jméno</Label>
        <Input id="name" name="name" autoComplete="name" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={invitedEmail}
          readOnly={Boolean(invitedEmail)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Heslo</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          aria-describedby="password-hint"
          required
        />
        <p id="password-hint" className="text-sm text-muted-foreground">
          Aspoň 12 znaků.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        Vytvořit účet
      </Button>
    </form>
  );
}
