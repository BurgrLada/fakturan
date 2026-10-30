import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rateLimit = sqliteTable(
  "rate_limit",
  {
    key: text().primaryKey(),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    count: integer().notNull(),
    denied: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("rate_limit_window_idx").on(t.windowStart)],
);
