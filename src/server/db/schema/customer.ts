import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CURRENCIES } from "@/lib/currency";
import { DOMESTIC_COUNTRY } from "@/lib/customers";
import { LANGUAGES } from "@/lib/preferences";
import { user } from "./auth";
import { importBatch } from "./import";

// A null override column means "use the account default" (CUS-003, SET-030).
export const customer = sqliteTable(
  "customer",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    street: text().notNull().default(""),
    city: text().notNull().default(""),
    zip: text().notNull().default(""),
    country: text().notNull().default(DOMESTIC_COUNTRY),
    ico: text().notNull().default(""),
    dic: text().notNull().default(""),
    email: text().notNull().default(""),
    extraEmails: text("extra_emails", { mode: "json" }).$type<string[]>().notNull().default([]),
    phone: text().notNull().default(""),
    note: text().notNull().default(""),
    searchText: text("search_text").notNull().default(""),
    dueDays: integer("due_days"),
    language: text({ enum: LANGUAGES }),
    currency: text({ enum: CURRENCIES }),
    designId: text("design_id"),
    remindersEnabled: integer("reminders_enabled", { mode: "boolean" }),
    vatVerifiedAt: integer("vat_verified_at", { mode: "timestamp_ms" }),
    vatValid: integer("vat_valid", { mode: "boolean" }),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    importBatchId: text("import_batch_id").references(() => importBatch.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("customer_user_idx").on(t.userId, t.name),
    index("customer_ico_idx").on(t.userId, t.ico),
  ],
);
