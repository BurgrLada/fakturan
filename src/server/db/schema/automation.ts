import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
