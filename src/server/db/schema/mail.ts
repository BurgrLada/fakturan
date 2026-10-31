import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
