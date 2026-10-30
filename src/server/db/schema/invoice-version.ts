import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { user } from "./auth";
import { invoice } from "./invoice";

export const invoiceVersion = sqliteTable(
  "invoice_version",
  {
    id: text().primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    document: text({ mode: "json" }).$type<InvoiceDocument>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("invoice_version_invoice_no_idx").on(t.invoiceId, t.versionNo),
    index("invoice_version_user_idx").on(t.userId),
  ],
);
