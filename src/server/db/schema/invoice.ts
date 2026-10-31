import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { CURRENCIES } from "@/lib/currency";
import { INVOICE_STATUSES, INVOICE_TYPES, type Appearance } from "@/lib/invoice";
import type { AccountSnapshot, CustomerSnapshot, SupplierSnapshot } from "@/lib/invoice-document";
import { DISCOUNT_KINDS, ROUNDING_MODES } from "@/lib/invoice-totals";
import { DATE_FORMATS, LANGUAGES, PAYMENT_METHODS } from "@/lib/preferences";
import { user } from "./auth";
import { bankAccount } from "./bank-account";
import { catalogItem } from "./catalog";
import { customer } from "./customer";
import { file } from "./file";
import { numberSeries } from "./number-series";
import { recurringInvoice } from "./recurring";

const imageRef = (name: string) => text(name).references(() => file.id, { onDelete: "set null" });

// customer_id, bank_account_id and related_invoice_id deliberately do not cascade, so
// USER_OWNED_TABLES must list invoice before those tables (ADM-006). A draft may lack dates and
// parties; issuing enforces them.
export const invoice = sqliteTable(
  "invoice",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text({ enum: INVOICE_TYPES }).notNull(),
    status: text({ enum: INVOICE_STATUSES }).notNull().default("draft"),
    cancelledFrom: text("cancelled_from", { enum: INVOICE_STATUSES }),
    number: text(),
    variableSymbol: text("variable_symbol"),
    variableSymbolManual: integer("variable_symbol_manual", { mode: "boolean" })
      .notNull()
      .default(false),
    // A used series is protected by its counter, and a draft picks a series again when issued.
    seriesId: text("series_id").references(() => numberSeries.id, { onDelete: "set null" }),
    customerId: text("customer_id").references(() => customer.id),
    customerName: text("customer_name").notNull().default(""),
    bankAccountId: text("bank_account_id").references(() => bankAccount.id),
    issueDate: text("issue_date"),
    dueDate: text("due_date"),
    taxableDate: text("taxable_date"),
    language: text({ enum: LANGUAGES }).notNull(),
    currency: text({ enum: CURRENCIES }).notNull(),
    exchangeRateMicros: integer("exchange_rate_micros"),
    paymentMethod: text("payment_method", { enum: PAYMENT_METHODS }).notNull(),
    orderRef: text("order_ref").notNull().default(""),
    reference: text().notNull().default(""),
    textBefore: text("text_before").notNull().default(""),
    textAfter: text("text_after").notNull().default(""),
    note: text().notNull().default(""),
    discountKind: text("discount_kind", { enum: DISCOUNT_KINDS }).notNull().default("none"),
    discountValue: integer("discount_value").notNull().default(0),
    rounding: text({ enum: ROUNDING_MODES }).notNull().default("none"),
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    discountMinor: integer("discount_minor").notNull().default(0),
    roundingMinor: integer("rounding_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull().default(0),
    paidMinor: integer("paid_minor").notNull().default(0),
    appearance: text({ mode: "json" }).$type<Appearance>().notNull(),
    supplierSnapshot: text("supplier_snapshot", { mode: "json" }).$type<SupplierSnapshot>(),
    customerSnapshot: text("customer_snapshot", { mode: "json" }).$type<CustomerSnapshot>(),
    accountSnapshot: text("account_snapshot", { mode: "json" }).$type<AccountSnapshot>(),
    // Fixed when issuing, so a later preference change cannot redraw an issued document.
    dateFormat: text("date_format", { enum: DATE_FORMATS }),
    logoFileId: imageRef("logo_file_id"),
    qrLogoFileId: imageRef("qr_logo_file_id"),
    signatureFileId: imageRef("signature_file_id"),
    relatedInvoiceId: text("related_invoice_id").references((): AnySQLiteColumn => invoice.id),
    external: integer({ mode: "boolean" }).notNull().default(false),
    recurringId: text("recurring_id").references((): AnySQLiteColumn => recurringInvoice.id, {
      onDelete: "set null",
    }),
    // Stored so a late issue still bills the plan's period, not the one of the issue date (R-15).
    periodFrom: text("period_from"),
    periodTo: text("period_to"),
    // Organisational, like tags: changing them leaves revision and versions alone.
    remindersOff: integer("reminders_off", { mode: "boolean" }).notNull().default(false),
    remindersSnoozeUntil: text("reminders_snooze_until"),
    remindersPartial: integer("reminders_partial", { mode: "boolean" }).notNull().default(false),
    searchText: text("search_text").notNull().default(""),
    revision: integer().notNull().default(0),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("invoice_user_number_idx")
      .on(t.userId, t.number)
      .where(sql`number IS NOT NULL`),
    index("invoice_user_status_idx").on(t.userId, t.status),
    index("invoice_user_issue_date_idx").on(t.userId, t.issueDate),
    index("invoice_user_customer_idx").on(t.userId, t.customerId),
    index("invoice_user_variable_symbol_idx").on(t.userId, t.variableSymbol),
    index("invoice_recurring_idx").on(t.recurringId),
  ],
);

export const invoiceLine = sqliteTable(
  "invoice_line",
  {
    id: text().primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    catalogItemId: text("catalog_item_id").references(() => catalogItem.id, {
      onDelete: "set null",
    }),
    name: text().notNull().default(""),
    description: text().notNull().default(""),
    quantityMilli: integer("quantity_milli").notNull(),
    unit: text().notNull().default(""),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    discountKind: text("discount_kind", { enum: DISCOUNT_KINDS }).notNull().default("none"),
    discountValue: integer("discount_value").notNull().default(0),
    netMinor: integer("net_minor").notNull(),
  },
  (t) => [
    index("invoice_line_invoice_idx").on(t.invoiceId, t.position),
    index("invoice_line_user_idx").on(t.userId),
  ],
);

export const tag = sqliteTable(
  "tag",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    nameKey: text("name_key").notNull(),
  },
  (t) => [uniqueIndex("tag_user_name_key_idx").on(t.userId, t.nameKey)],
);

export const invoiceTag = sqliteTable(
  "invoice_tag",
  {
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.invoiceId, t.tagId] }),
    index("invoice_tag_tag_idx").on(t.tagId),
    index("invoice_tag_user_idx").on(t.userId),
  ],
);
