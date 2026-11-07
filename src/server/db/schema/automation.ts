import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DEFAULT_SEND_TIME } from "@/lib/automation";
import { PERIOD_SUMMARIES } from "@/lib/owner-reports";
import { user } from "./auth";

const flag = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);

// Created on the first change; getAutomation reads a missing row as everything off.
export const automationSettings = sqliteTable("automation_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  recurringSend: flag("recurring_send"),
  reminders: flag("reminders"),
  paymentReceipt: flag("payment_receipt"),
  advanceInvoice: flag("advance_invoice"),
  paused: flag("paused"),
  remindersOpenSince: text("reminders_open_since"),
  sendTime: text("send_time").notNull().default(DEFAULT_SEND_TIME),
  dailyDigest: flag("daily_digest"),
  periodSummary: text("period_summary", { enum: PERIOD_SUMMARIES }).notNull().default("off"),
  taxReminder: flag("tax_reminder"),
  limitMail: flag("limit_mail"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// The lasting record that a VAT limit threshold of a year was handled, sent or jumped over. Job rows
// expire after their retention, this does not, so a threshold never repeats (C-1 of block C).
export const limitMailSent = sqliteTable(
  "limit_mail_sent",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    year: integer().notNull(),
    threshold: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("limit_mail_sent_user_year_idx").on(t.userId, t.year, t.threshold)],
);
