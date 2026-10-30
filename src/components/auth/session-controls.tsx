"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        onClick={async () => {
          const { error } = await authClient.signOut();
          setFailed(Boolean(error));
          if (error) return;
          router.push("/prihlaseni");
          router.refresh();
        }}
      >
        Odhlásit se
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Odhlášení se nepovedlo, zkuste to prosím znovu.
        </p>
      )}
    </>
  );
}

const SESSION_CHECK_MS = 60_000;

// Only this endpoint can rewrite the cookie, see getCurrentSession. It also ends a tab whose session
// was revoked elsewhere (ADM-005); a failed request must not look like a lost session.
export function SessionKeepAlive() {
  useEffect(() => {
    async function check() {
      if (document.visibilityState !== "visible") return;
      const { data, error } = await authClient.getSession();
      if (!data && !error) window.location.assign("/prihlaseni");
    }
    void check();
    const interval = setInterval(check, SESSION_CHECK_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return null;
}
