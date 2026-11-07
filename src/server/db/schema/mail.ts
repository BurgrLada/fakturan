import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { AUTOMATION_KEYS } from "@/lib/automation";
import { MESSAGE_KINDS } from "@/lib/email-template";
import { EMAIL_STATUSES, EMAIL_TRIGGERS } from "@/lib/mail-send";
import { LANGUAGES } from "@/lib/preferences";
import { user } from "./auth";
import { file } from "./file";
import { invoice } from "./invoice";

export const mailSettings = sqliteTable("mail_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpUser: text("smtp_user"),
  smtpPasswordEnc: text("smtp_password_enc"),
  fromEmail: text("from_email"),
  senderName: text("sender_name"),
  replyTo: text("reply_to"),
  cc: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  bcc: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const emailTemplate = sqliteTable(
  "email_template",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text({ enum: MESSAGE_KINDS }).notNull(),
    language: text({ enum: LANGUAGES }).notNull(),
    subject: text().notNull(),
    body: text().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("email_template_user_kind_language_idx").on(t.userId, t.kind, t.language)],
);

export type ReceiptPrint = { creditedMinor: number; paidOn: string; dueMinor: number };

export type HtmlImage = { cid: string; fileId: string };

export const emailLog = sqliteTable(
  "email_log",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    kind: text({ enum: MESSAGE_KINDS }).notNull(),
    trigger: text({ enum: EMAIL_TRIGGERS }).notNull(),
    to: text({ mode: "json" }).$type<string[]>().notNull(),
    cc: text({ mode: "json" }).$type<string[]>().notNull(),
    bcc: text({ mode: "json" }).$type<string[]>().notNull(),
    subject: text().notNull(),
    body: text().notNull(),
    status: text({ enum: EMAIL_STATUSES }).notNull().default("queued"),
    reason: text(),
    fileId: text("file_id").references(() => file.id, { onDelete: "set null" }),
    // Chosen in the dialog; never set by automation (R-25).
    attachIsdoc: integer("attach_isdoc", { mode: "boolean" }).notNull().default(false),
    isdocFileId: text("isdoc_file_id").references(() => file.id, { onDelete: "set null" }),
    // The HTML and its inline images as first built; another attempt sends exactly these (R-19).
    htmlFileId: text("html_file_id").references(() => file.id, { onDelete: "set null" }),
    htmlImages: text("html_images", { mode: "json" }).$type<HtmlImage[]>(),
    invoiceRevision: integer("invoice_revision").notNull(),
    plannedFor: text("planned_for"),
    automation: text({ enum: AUTOMATION_KEYS }),
    stageKey: text("stage_key"),
    // No foreign key: the record has to outlive a removed payment to say why it was held (R-24).
    paymentId: text("payment_id"),
    // What the text stated when it was queued; a resend must not repeat figures that changed since.
    receiptPrint: text("receipt_print", { mode: "json" }).$type<ReceiptPrint>(),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
    attempts: integer().notNull().default(0),
    messageId: text("message_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("email_log_user_invoice_created_idx").on(t.userId, t.invoiceId, t.createdAt),
    uniqueIndex("email_log_running_idx")
      .on(t.invoiceId, t.kind, sql`coalesce(payment_id, '')`)
      .where(sql`${t.status} IN ('queued', 'sending')`),
  ],
);

export type EmailLog = typeof emailLog.$inferSelect;
