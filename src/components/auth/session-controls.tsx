"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      onClick={async () => {
        await authClient.signOut();
        router.push("/prihlaseni");
        router.refresh();
      }}
    >
      Odhlásit se
    </Button>
  );
}

// Only this endpoint can rewrite the cookie, see getCurrentSession.
export function SessionKeepAlive() {
  useEffect(() => {
    void authClient.getSession();
  }, []);
  return null;
}
