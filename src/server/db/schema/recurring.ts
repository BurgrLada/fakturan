import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type { TemplateDocument } from "@/lib/invoice-template";
import {
  ISSUE_RULES,
  RECURRENCE_FREQUENCIES,
  RECURRING_MODES,
  RECURRING_STATUSES,
  RUN_STATUSES,
} from "@/lib/recurrence";
import { user } from "./auth";
import { customer } from "./customer";
import { invoice } from "./invoice";

// Holds its own copy of the document, so a template edit never changes what leaves for a client.
export const recurringInvoice = sqliteTable(
  "recurring_invoice",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    customerId: text("customer_id").references(() => customer.id, { onDelete: "set null" }),
    document: text({ mode: "json" }).$type<TemplateDocument>().notNull(),
    frequency: text({ enum: RECURRENCE_FREQUENCIES }).notNull(),
    every: integer().notNull().default(1),
    issueRule: text("issue_rule", { enum: ISSUE_RULES }).notNull(),
    issueDay: integer("issue_day"),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on"),
    maxCount: integer("max_count"),
    periodOffset: integer("period_offset").notNull().default(0),
    mode: text({ enum: RECURRING_MODES }).notNull().default("draft"),
    notifyDaysBefore: integer("notify_days_before"),
    status: text({ enum: RECURRING_STATUSES }).notNull().default("active"),
    // Occurrences up to and including this date are already planned.
    cursorDate: text("cursor_date").notNull(),
    sendConfirmedAt: integer("send_confirmed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("recurring_invoice_user_idx").on(t.userId, t.status)],
);

export const recurringRun = sqliteTable(
  "recurring_run",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    recurringId: text("recurring_id")
      .notNull()
      .references(() => recurringInvoice.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    plannedDate: text("planned_date").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    status: text({ enum: RUN_STATUSES }).notNull(),
    invoiceId: text("invoice_id").references((): AnySQLiteColumn => invoice.id, {
      onDelete: "set null",
    }),
    reason: text(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("recurring_run_period_idx").on(t.recurringId, t.periodKey),
    index("recurring_run_user_idx").on(t.userId),
    index("recurring_run_invoice_idx").on(t.invoiceId),
  ],
);

export type RecurringInvoice = typeof recurringInvoice.$inferSelect;
export type RecurringRun = typeof recurringRun.$inferSelect;
