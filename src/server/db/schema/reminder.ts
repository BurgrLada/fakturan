import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { EMAIL_TRIGGERS } from "@/lib/mail-send";
import type { ReminderTexts } from "@/lib/reminders";
import { user } from "./auth";
import { invoice } from "./invoice";
import { emailLog } from "./mail";

export const reminderRule = sqliteTable(
  "reminder_rule",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    offsetDays: integer("offset_days").notNull(),
    texts: text({ mode: "json" }).$type<ReminderTexts>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("reminder_rule_user_offset_idx").on(t.userId, t.offsetDays)],
);

// stage_key has no foreign key on purpose: deleting a rule must not reopen a stage already sent.
export const reminderSent = sqliteTable(
  "reminder_sent",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    stageKey: text("stage_key").notNull(),
    trigger: text({ enum: EMAIL_TRIGGERS }).notNull(),
    emailLogId: text("email_log_id").references(() => emailLog.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("reminder_sent_automatic_idx")
      .on(t.invoiceId, t.stageKey)
      .where(sql`${t.trigger} = 'automatic'`),
    index("reminder_sent_user_invoice_idx").on(t.userId, t.invoiceId),
  ],
);

export type ReminderRuleRow = typeof reminderRule.$inferSelect;
export type ReminderSentRow = typeof reminderSent.$inferSelect;
