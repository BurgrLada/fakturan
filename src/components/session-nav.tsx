import { NavLinks } from "@/components/nav-links";
import { visibleNavItems } from "@/components/nav";
import { SignOutButton } from "@/components/auth/session-controls";
import { TEXTS } from "@/lib/texts";
import { getCurrentSession } from "@/server/auth/session";

export const defaultNavKeys = visibleNavItems("user").map((entry) => entry.key);

export async function SessionNav() {
  const session = await getCurrentSession();
  return <NavLinks keys={visibleNavItems(session?.user.role).map((entry) => entry.key)} />;
}

export async function AccountMenu() {
  const session = await getCurrentSession();
  if (!session) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{TEXTS.shell.signedInAs}</p>
      <p className="text-sm break-all">{session.user.email}</p>
      <SignOutButton />
    </div>
  );
}
