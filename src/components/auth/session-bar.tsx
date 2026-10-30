import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getCurrentSession } from "@/server/auth/session";
import { SessionKeepAlive, SignOutButton } from "./session-controls";

export async function SessionBar() {
  const session = await getCurrentSession();
  if (!session) {
    return (
      <Button variant="outline" render={<Link href="/prihlaseni" />} nativeButton={false}>
        Přihlásit se
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{session.user.email}</span>
      <SignOutButton />
      <SessionKeepAlive />
    </div>
  );
}
