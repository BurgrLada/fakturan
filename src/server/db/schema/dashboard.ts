import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { WidgetConfig } from "@/lib/widget-config";
import { user } from "./auth";

export const dashboard = sqliteTable(
  "dashboard",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    position: integer().notNull().default(0),
    revision: integer().notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("dashboard_user_idx").on(t.userId, t.position),
    // One default per account even when two tabs create it at once (R-19).
    uniqueIndex("dashboard_default_idx")
      .on(t.userId)
      .where(sql`is_default = 1`),
  ],
);

export const dashboardWidget = sqliteTable(
  "dashboard_widget",
  {
    id: text().primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboard.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    config: text({ mode: "json" }).$type<WidgetConfig>().notNull(),
    x: integer().notNull(),
    y: integer().notNull(),
    w: integer().notNull(),
    h: integer().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("dashboard_widget_user_idx").on(t.userId),
    index("dashboard_widget_dashboard_idx").on(t.dashboardId, t.userId),
  ],
);

export type Dashboard = typeof dashboard.$inferSelect;
