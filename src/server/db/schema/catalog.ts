import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CURRENCIES } from "@/lib/currency";
import { user } from "./auth";

export const catalogItem = sqliteTable(
  "catalog_item",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    unit: text().notNull(),
    priceMinor: integer("price_minor").notNull(),
    currency: text({ enum: CURRENCIES }).notNull(),
    category: text().notNull().default(""),
    tags: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    searchText: text("search_text").notNull().default(""),
    useCount: integer("use_count").notNull().default(0),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("catalog_item_user_idx").on(t.userId, t.name),
    index("catalog_item_usage_idx").on(t.userId, t.useCount),
  ],
);

export const unit = sqliteTable(
  "unit",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    position: integer().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("unit_user_name_idx").on(t.userId, t.name)],
);
