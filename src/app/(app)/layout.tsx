import { Suspense } from "react";
import { SessionKeepAlive } from "@/components/auth/session-controls";
import { AppShell } from "@/components/app-shell";
import { NavLinksView } from "@/components/nav-links";
import { AccountMenu, defaultNavKeys, SessionNav } from "@/components/session-nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      nav={
        <Suspense fallback={<NavLinksView keys={defaultNavKeys} pathname={null} />}>
          <SessionNav />
        </Suspense>
      }
      account={
        <Suspense>
          <AccountMenu />
        </Suspense>
      }
    >
      {children}
      <SessionKeepAlive />
    </AppShell>
  );
}
