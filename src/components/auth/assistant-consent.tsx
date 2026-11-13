"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { TEXTS } from "@/lib/texts";

const C = TEXTS.mcp.consent;

// The answer goes to the provider with the signed query; it replies with the client's callback,
// carrying a code or access_denied (MCP-005).
export function AssistantConsent({
  host,
  levelName,
  levelDescription,
  oauthQuery,
}: {
  host: string;
  levelName: string;
  levelDescription: string;
  oauthQuery: string;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function answer(accept: boolean) {
    setPending(true);
    setFailed(false);
    const { data, error } = await authClient.oauth2.consent({ accept, oauth_query: oauthQuery });
    if (error || !data?.url) {
      setPending(false);
      setFailed(true);
      return;
    }
    window.location.assign(data.url);
  }

  return (
    <div className="flex flex-col gap-4">
      {host && (
        <p className="text-sm">
          <span className="text-muted-foreground">{C.hostLabel}: </span>
          <span className="break-all">{host}</span>
        </p>
      )}
      <p className="text-sm text-muted-foreground">{C.nameIsClaimed}</p>
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">{C.level(levelName)}</p>
        <p>{levelDescription}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {C.settingsHint}{" "}
        <Link href="/nastaveni/asistenti" className="underline">
          {C.settingsLink}
        </Link>
        .
      </p>
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>{C.failed}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="button" className="flex-1" disabled={pending} onClick={() => answer(true)}>
          {C.allow}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={pending}
          onClick={() => answer(false)}
        >
          {C.deny}
        </Button>
      </div>
    </div>
  );
}
