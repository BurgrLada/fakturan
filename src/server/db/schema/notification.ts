import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { NOTIFICATION_KINDS, type NotificationParams } from "@/lib/automation";
import { user } from "./auth";

// Events only: what is overdue is computed on read, so it disappears by itself once paid.
export const notification = sqliteTable(
  "notification",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text({ enum: NOTIFICATION_KINDS }).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    params: text({ mode: "json" }).$type<NotificationParams>().notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("notification_user_dedupe_idx").on(t.userId, t.dedupeKey),
    index("notification_user_read_idx").on(t.userId, t.readAt, t.createdAt),
  ],
);

export type Notification = typeof notification.$inferSelect;
