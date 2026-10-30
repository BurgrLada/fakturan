import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CURRENCIES } from "@/lib/currency";
import { user } from "./auth";

export const bankAccount = sqliteTable(
  "bank_account",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    currency: text({ enum: CURRENCIES }).notNull(),
    number: text().notNull().default(""),
    bankCode: text("bank_code").notNull().default(""),
    iban: text().notNull(),
    swift: text().notNull().default(""),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    hidden: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("bank_account_user_idx").on(t.userId),
    uniqueIndex("bank_account_default_idx")
      .on(t.userId, t.currency)
      .where(sql`is_default = 1`),
  ],
);
