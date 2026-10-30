"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient, authErrorMessage } from "@/lib/auth-client";
import { TEXTS } from "@/lib/texts";
import type { ProviderId } from "@/server/auth/providers";

export type LinkedAccount = { id: string; providerId: string };

const LINK_ERROR_URL = "/nastaveni/ucet?chyba=propojeni";

function providerLabel(providerId: string): string {
  if (providerId === "credential") return TEXTS.linked.password;
  return TEXTS.linked[providerId as ProviderId] ?? providerId;
}

export function LinkedAccounts({
  accounts,
  available,
}: {
  accounts: LinkedAccount[];
  available: ProviderId[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const linked = new Set(accounts.map((account) => account.providerId));
  const unlinkable = accounts.length > 1;

  function remove(account: LinkedAccount) {
    startTransition(async () => {
      const { error } = await authClient.unlinkAccount({ accountId: account.id });
      if (error) {
        setMessage({ ok: false, text: authErrorMessage(error.code) });
        return;
      }
      setMessage({ ok: true, text: TEXTS.linked.removed });
      router.refresh();
    });
  }

  async function add(provider: ProviderId) {
    const { error } = await authClient.linkSocial({
      provider,
      callbackURL: "/nastaveni/ucet",
      errorCallbackURL: LINK_ERROR_URL,
    });
    if (error) setMessage({ ok: false, text: authErrorMessage(error.code) });
  }

  return (
    <div className="flex flex-col gap-3 sm:max-w-md">
      {message && (
        <Alert
          variant={message.ok ? "default" : "destructive"}
          role={message.ok ? "status" : "alert"}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <ul className="flex flex-col divide-y rounded-md border">
        {accounts.map((account) => (
          <li key={account.id} className="flex items-center justify-between gap-2 p-2 text-sm">
            <span>{providerLabel(account.providerId)}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || !unlinkable}
              aria-label={`${TEXTS.linked.remove} ${providerLabel(account.providerId)}`}
              onClick={() => remove(account)}
            >
              {TEXTS.linked.remove}
            </Button>
          </li>
        ))}
      </ul>
      {!unlinkable && <p className="text-sm text-muted-foreground">{TEXTS.linked.lastMethod}</p>}
      {available
        .filter((provider) => !linked.has(provider))
        .map((provider) => (
          <Button
            key={provider}
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => add(provider)}
          >
            {TEXTS.linked.add}: {TEXTS.linked[provider]}
          </Button>
        ))}
    </div>
  );
}
