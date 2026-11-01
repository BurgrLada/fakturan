import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CURRENCIES } from "@/lib/currency";

// Shared by every account and owned by none, so it is not in USER_OWNED_TABLES. The rate is CZK per
// one unit of the currency times 1 000 000.
export const exchangeRate = sqliteTable(
  "exchange_rate",
  {
    currency: text({ enum: CURRENCIES }).notNull(),
    listDate: text("list_date").notNull(),
    rateMicros: integer("rate_micros").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.currency, t.listDate] })],
);
