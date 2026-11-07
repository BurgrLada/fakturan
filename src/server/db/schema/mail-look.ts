import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DEFAULT_MAIL_LAYOUT, MAIL_LAYOUTS, MAIL_LOGO_MODES } from "@/lib/mail-look";
import { user } from "./auth";
import { file } from "./file";

export const mailLook = sqliteTable("mail_look", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  layout: text({ enum: MAIL_LAYOUTS }).notNull().default(DEFAULT_MAIL_LAYOUT),
  intro: text(),
  signature: text(),
  logoMode: text("logo_mode", { enum: MAIL_LOGO_MODES }).notNull().default("supplier"),
  logoFileId: text("logo_file_id").references(() => file.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type MailLookRow = typeof mailLook.$inferSelect;
