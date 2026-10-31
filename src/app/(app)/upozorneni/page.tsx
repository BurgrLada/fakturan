import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { NotificationList } from "@/components/notifications/notification-list";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import "@/server/services/due-alerts";
import { derivedAlerts, listNotifications } from "@/server/services/notifications";

export const metadata: Metadata = { title: `${TEXTS.notifications.title} | ${TEXTS.appName}` };

const T = TEXTS.notifications;

async function NotificationsContent({
  searchParams,
}: Pick<PageProps<"/upozorneni">, "searchParams">) {
  const { user } = await requireSession();
  const raw = (await searchParams).strana;
  const page = listNotifications(user.id, Number(Array.isArray(raw) ? raw[0] : raw));
  const derived = derivedAlerts(user.id);
  const rows = [
    ...derived.map((alert) => ({
      id: `derived:${alert.dedupeKey}`,
      kind: alert.kind,
      params: alert.params,
      createdAt: null,
      read: true,
      resolved: false,
    })),
    ...page.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      params: row.params,
      createdAt: row.createdAt.toISOString(),
      read: row.readAt !== null,
      resolved: row.resolvedAt !== null,
    })),
  ];
  if (rows.length === 0) {
    return <EmptyState icon={Bell} title={T.empty} description={T.emptyBody} />;
  }
  return (
    <>
      <NotificationList rows={rows} canMarkAll={page.rows.some((row) => row.readAt === null)} />
      <nav className="flex gap-2">
        {page.page > 1 && (
          <Link
            href={`/upozorneni?strana=${page.page - 1}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {T.newer}
          </Link>
        )}
        {page.hasNext && (
          <Link
            href={`/upozorneni?strana=${page.page + 1}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {T.older}
          </Link>
        )}
      </nav>
    </>
  );
}

export default function NotificationsPage(props: PageProps<"/upozorneni">) {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <NotificationsContent searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}
