import { Suspense } from "react";
import { SessionKeepAlive } from "@/components/auth/session-controls";
import { AppShell } from "@/components/app-shell";
import {
  NotificationBell,
  NotificationBellView,
} from "@/components/notifications/notification-bell";
import { NavLinksView } from "@/components/nav-links";
import {
  AccountMenu,
  defaultNavKeys,
  SessionNav,
  SessionQuickSearch,
} from "@/components/session-nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      nav={
        <Suspense fallback={<NavLinksView keys={defaultNavKeys} pathname={null} />}>
          <SessionNav />
        </Suspense>
      }
      bell={
        <Suspense fallback={<NotificationBellView count={0} />}>
          <NotificationBell />
        </Suspense>
      }
      account={
        <Suspense>
          <AccountMenu />
        </Suspense>
      }
      search={
        <Suspense>
          <SessionQuickSearch />
        </Suspense>
      }
    >
      {children}
      <SessionKeepAlive />
    </AppShell>
  );
}
