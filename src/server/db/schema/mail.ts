import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { MESSAGE_KINDS } from "@/lib/email-template";
import { LANGUAGES } from "@/lib/preferences";
import { user } from "./auth";

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
