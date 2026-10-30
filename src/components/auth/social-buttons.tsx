"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { ProviderId } from "@/server/auth/providers";

const LABELS: Record<ProviderId, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
};

export function SocialButtons({ providers }: { providers: ProviderId[] }) {
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          onClick={() =>
            authClient.signIn.social({
              provider,
              callbackURL: "/",
              errorCallbackURL: "/prihlaseni",
            })
          }
        >
          Pokračovat přes {LABELS[provider]}
        </Button>
      ))}
    </div>
  );
}
