import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { file } from "./file";

const imageRef = (name: string) => text(name).references(() => file.id, { onDelete: "set null" });

export const supplier = sqliteTable("supplier", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text().notNull().default(""),
  street: text().notNull().default(""),
  city: text().notNull().default(""),
  zip: text().notNull().default(""),
  country: text().notNull().default("Česká republika"),
  ico: text().notNull().default(""),
  dic: text().notNull().default(""),
  email: text().notNull().default(""),
  phone: text().notNull().default(""),
  web: text().notNull().default(""),
  registryNote: text("registry_note").notNull().default(""),
  contactPerson: text("contact_person").notNull().default(""),
  vatIdentified: integer("vat_identified", { mode: "boolean" }).notNull().default(false),
  footerText: text("footer_text").notNull().default(""),
  notVatPayerCs: text("not_vat_payer_cs").notNull().default("Nejsem plátce DPH."),
  notVatPayerEn: text("not_vat_payer_en").notNull().default("I am not a VAT payer."),
  logoFileId: imageRef("logo_file_id"),
  qrLogoFileId: imageRef("qr_logo_file_id"),
  signatureFileId: imageRef("signature_file_id"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
