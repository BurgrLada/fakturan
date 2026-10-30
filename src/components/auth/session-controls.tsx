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

// Only this endpoint can rewrite the cookie, see getCurrentSession.
export function SessionKeepAlive() {
  useEffect(() => {
    void authClient.getSession();
  }, []);
  return null;
}
