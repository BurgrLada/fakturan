import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { BANK_FAILURE_CODES, BANK_TLS_MODES, DEFAULT_BANK_FOLDER } from "@/lib/bank-mailbox";
import { user } from "./auth";

export const bankMailbox = sqliteTable("bank_mailbox", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  host: text().notNull(),
  port: integer().notNull(),
  tls: text({ enum: BANK_TLS_MODES }).notNull(),
  username: text().notNull(),
  passwordEnc: text("password_enc").notNull(),
  folder: text().notNull().default(DEFAULT_BANK_FOLDER),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  requireConfirmation: integer("require_confirmation", { mode: "boolean" }).notNull().default(true),
  uidValidity: integer("uid_validity"),
  lastUid: integer("last_uid"),
  firstReadAt: integer("first_read_at", { mode: "timestamp_ms" }),
  lastCheckAt: integer("last_check_at", { mode: "timestamp_ms" }),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
  lastNoticeAt: integer("last_notice_at", { mode: "timestamp_ms" }),
  failureCode: text("failure_code", { enum: BANK_FAILURE_CODES }),
  failures: integer().notNull().default(0),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
