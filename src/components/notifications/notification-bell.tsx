import { Bell } from "lucide-react";
import Link from "next/link";
import { TEXTS } from "@/lib/texts";
import { getCurrentSession } from "@/server/auth/session";
import "@/server/services/due-alerts";
import { unreadCount } from "@/server/services/notifications";

export function NotificationBellView({ count }: { count: number }) {
  return (
    <Link
      href="/upozorneni"
      aria-label={TEXTS.shell.notificationsUnread(count)}
      className="relative inline-flex size-8 items-center justify-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
    >
      <Bell aria-hidden className="size-4" />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}

export async function NotificationBell() {
  const session = await getCurrentSession();
  if (!session) return null;
  return <NotificationBellView count={unreadCount(session.user.id)} />;
}
