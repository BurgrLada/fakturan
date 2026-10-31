import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { TemplateDocument } from "@/lib/invoice-template";
import { user } from "./auth";
import { customer } from "./customer";

export const invoiceTemplate = sqliteTable(
  "invoice_template",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    customerId: text("customer_id").references(() => customer.id, { onDelete: "set null" }),
    document: text({ mode: "json" }).$type<TemplateDocument>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("invoice_template_user_idx").on(t.userId, t.name)],
);
