import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  DATE_FORMATS,
  DEFAULT_PREFERENCES as D,
  FX_BASES,
  ISSUE_DATE_MODES,
  LANGUAGES,
  LOGO_POSITIONS,
  PAYMENT_METHODS,
  VARIABLE_SYMBOL_FORMATS,
} from "@/lib/preferences";
import { CURRENCIES } from "@/lib/currency";
import { ROUNDING_MODES } from "@/lib/invoice-totals";
import { user } from "./auth";

const flag = (name: string, value: boolean) =>
  integer(name, { mode: "boolean" }).notNull().default(value);

// Created on the first save; getPreferences falls back to the defaults while there is no row.
export const preferences = sqliteTable("preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  dueDays: integer("due_days").notNull().default(D.dueDays),
  language: text({ enum: LANGUAGES }).notNull().default(D.language),
  currency: text({ enum: CURRENCIES }).notNull().default(D.currency),
  designId: text("design_id").notNull().default(D.designId),
  accentColor: text("accent_color").notNull().default(D.accentColor),
  surfaceColor: text("surface_color").notNull().default(D.surfaceColor),
  textColor: text("text_color").notNull().default(D.textColor),
  lineColor: text("line_color").notNull().default(D.lineColor),
  logoPosition: text("logo_position", { enum: LOGO_POSITIONS }).notNull().default(D.logoPosition),
  paymentMethod: text("payment_method", { enum: PAYMENT_METHODS })
    .notNull()
    .default(D.paymentMethod),
  unit: text().notNull().default(D.unit),
  showLogo: flag("show_logo", D.showLogo),
  showQr: flag("show_qr", D.showQr),
  showQrLogo: flag("show_qr_logo", D.showQrLogo),
  showSignature: flag("show_signature", D.showSignature),
  showDuzp: flag("show_duzp", D.showDuzp),
  textBefore: text("text_before").notNull().default(D.textBefore),
  textAfter: text("text_after").notNull().default(D.textAfter),
  note: text().notNull().default(D.note),
  issueDateMode: text("issue_date_mode", { enum: ISSUE_DATE_MODES })
    .notNull()
    .default(D.issueDateMode),
  dateFormat: text("date_format", { enum: DATE_FORMATS }).notNull().default(D.dateFormat),
  variableSymbolFormat: text("variable_symbol_format", { enum: VARIABLE_SYMBOL_FORMATS })
    .notNull()
    .default(D.variableSymbolFormat),
  rounding: text({ enum: ROUNDING_MODES }).notNull().default(D.rounding),
  pdfFileName: text("pdf_file_name").notNull().default(D.pdfFileName),
  fxBasis: text("fx_basis", { enum: FX_BASES }).notNull().default(D.fxBasis),
  onboardingCompletedAt: integer("onboarding_completed_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
