import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CURRENCIES } from "@/lib/currency";
import { PAYMENT_CHANNELS, PAYMENT_KINDS, PAYMENT_SOURCES } from "@/lib/payments";
import { user } from "./auth";
import { invoice } from "./invoice";

// invoice_id does not cascade: USER_OWNED_TABLES must list payment before invoice, and a document
// with a payment must never disappear on its own. credited_minor is always in the invoice currency.
export const payment = sqliteTable(
  "payment",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoice.id),
    kind: text({ enum: PAYMENT_KINDS }).notNull(),
    paidOn: text("paid_on").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text({ enum: CURRENCIES }).notNull(),
    creditedMinor: integer("credited_minor").notNull(),
    method: text({ enum: PAYMENT_CHANNELS }).notNull(),
    note: text().notNull().default(""),
    source: text({ enum: PAYMENT_SOURCES }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("payment_user_invoice_idx").on(t.userId, t.invoiceId),
    index("payment_user_paid_on_idx").on(t.userId, t.paidOn),
  ],
);
