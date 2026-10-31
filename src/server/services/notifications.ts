import "server-only";
import { randomUUID } from "node:crypto";
import { count, desc, isNull } from "drizzle-orm";
import type { Alert, NotificationKind, NotificationParams } from "@/lib/automation";
import { calendarDateInPrague } from "@/lib/number-format";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { notification } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

const PAGE_SIZE = 25;

export type NotificationInput = {
  userId: string;
  kind: NotificationKind;
  dedupeKey: string;
  params: NotificationParams;
  entity?: { type: string; id: string };
};

// Runs inside the caller's transaction, so the event exists exactly when the change that caused it does.
export function notify(tx: Tx, input: NotificationInput): void {
  tx.insert(notification)
    .values({
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      params: input.params,
      entityType: input.entity?.type ?? null,
      entityId: input.entity?.id ?? null,
      createdAt: clock.now(),
    })
    .onConflictDoNothing()
    .run();
}

export function resolveNotification(tx: Tx, userId: string, dedupeKey: string): void {
  tx.update(notification)
    .set({ resolvedAt: clock.now() })
    .where(
      scoped(userId).where(notification, (t, { eq, and }) =>
        and(eq(t.dedupeKey, dedupeKey), isNull(t.resolvedAt)),
      ),
    )
    .run();
}

export function resolveNotificationsOf(tx: Tx, userId: string, kind: NotificationKind): void {
  tx.update(notification)
    .set({ resolvedAt: clock.now() })
    .where(
      scoped(userId).where(notification, (t, { eq, and }) =>
        and(eq(t.kind, kind), isNull(t.resolvedAt)),
      ),
    )
    .run();
}

export function listNotifications(ownerId: string, page: number) {
  const current = Number.isInteger(page) && page > 0 ? page : 1;
  const rows = db
    .select()
    .from(notification)
    .where(scoped(ownerId).where(notification))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(PAGE_SIZE + 1)
    .offset((current - 1) * PAGE_SIZE)
    .all();
  return {
    rows: rows.slice(0, PAGE_SIZE),
    page: current,
    pageSize: PAGE_SIZE,
    hasNext: rows.length > PAGE_SIZE,
  };
}

// Derived alerts have no read state: they count for as long as their cause lasts.
export function unreadCount(ownerId: string): number {
  const row = db
    .select({ n: count() })
    .from(notification)
    .where(
      scoped(ownerId).where(notification, (t, { and }) =>
        and(isNull(t.readAt), isNull(t.resolvedAt)),
      ),
    )
    .get();
  return (row?.n ?? 0) + derivedAlerts(ownerId).length;
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError("Na tuto akci nemáte oprávnění");
  return actor.userId;
}

export function markRead(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  const target = db
    .select({ id: notification.id })
    .from(notification)
    .where(
      scoped(userId).where(notification, (t, { eq, and }) => and(eq(t.id, id), isNull(t.readAt))),
    )
    .get();
  if (!target) return;
  mutate(actor, "notification.read", (tx, audit) => {
    tx.update(notification)
      .set({ readAt: clock.now() })
      .where(
        scoped(userId).where(notification, (t, { eq, and }) => and(eq(t.id, id), isNull(t.readAt))),
      )
      .run();
    audit({ entity: "notification", entityId: id, ownerId: userId, scope: "user" });
  });
}

export function markAllRead(actor: Actor): void {
  const userId = ownerOf(actor);
  if (!hasUnread(userId)) return;
  mutate(actor, "notification.read_all", (tx, audit) => {
    tx.update(notification)
      .set({ readAt: clock.now() })
      .where(scoped(userId).where(notification, (t) => isNull(t.readAt)))
      .run();
    audit({ entity: "notification", entityId: userId, ownerId: userId, scope: "user" });
  });
}

export function hasUnread(ownerId: string): boolean {
  return (
    db
      .select({ id: notification.id })
      .from(notification)
      .where(scoped(ownerId).where(notification, (t) => isNull(t.readAt)))
      .get() !== undefined
  );
}

type AlertSource = (ownerId: string, today: string) => Alert[];

const sources: AlertSource[] = [];

export function registerDerivedAlerts(source: AlertSource): void {
  sources.push(source);
}

export function derivedAlerts(ownerId: string): Alert[] {
  const today = calendarDateInPrague(clock.now());
  return sources.flatMap((source) => source(ownerId, today));
}

// Derived alerts are not events with a page of their own, so they lead the first page only.
export function notificationFeed(ownerId: string, page: number) {
  const events = listNotifications(ownerId, page);
  return {
    ...events,
    derived: events.page === 1 ? derivedAlerts(ownerId) : [],
    canMarkAll: hasUnread(ownerId),
  };
}
