import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { BANK_FAILURE_CODES, BANK_TLS_MODES, DEFAULT_BANK_FOLDER } from "@/lib/bank-mailbox";
import { CURRENCIES } from "@/lib/currency";
import { user } from "./auth";
import { bankAccount } from "./bank-account";

export const NOTICE_STATUSES = [
  "matched",
  "pending",
  "ignored",
  "unrecognized",
  "dismissed",
] as const;
export const NOTICE_AUTH_RESULTS = ["pass", "fail", "none"] as const;

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

// A row outlives its 90 days without personal data: dedupe_key must stay, or a message read again
// after a UIDVALIDITY reset would pay a second time (R-18).
export const bankNotification = sqliteTable(
  "bank_notification",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    bank: text().notNull(),
    variant: text(),
    status: text({ enum: NOTICE_STATUSES }).notNull(),
    reason: text(),
    authResult: text("auth_result", { enum: NOTICE_AUTH_RESULTS }).notNull(),
    bankAccountId: text("bank_account_id").references(() => bankAccount.id, {
      onDelete: "set null",
    }),
    accountMasked: text("account_masked"),
    amountMinor: integer("amount_minor"),
    currency: text({ enum: CURRENCIES }),
    paidOn: text("paid_on"),
    paidTime: text("paid_time"),
    variableSymbol: text("variable_symbol"),
    constantSymbol: text("constant_symbol"),
    counterpartyMasked: text("counterparty_masked"),
    counterpartyName: text("counterparty_name"),
    message: text(),
    instructionId: text("instruction_id"),
    textMasked: text("text_masked"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    purgedAt: integer("purged_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("bank_notification_user_dedupe_idx").on(t.userId, t.dedupeKey),
    index("bank_notification_user_status_idx").on(t.userId, t.status, t.receivedAt),
  ],
);

export type BankNotification = typeof bankNotification.$inferSelect;
