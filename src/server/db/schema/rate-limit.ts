import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rateLimit = sqliteTable("rate_limit", {
  key: text().primaryKey(),
  windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
  count: integer().notNull(),
});
