import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { importBatch } from "./import";

export const FILE_KINDS = [
  "logo",
  "qr_logo",
  "signature",
  "sent_pdf",
  "import_upload",
  "import_pdf",
  "sent_isdoc",
  "export",
  "audit_archive",
  "mail_logo",
  "sent_html",
  "sent_image",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const file = sqliteTable(
  "file",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text({ enum: FILE_KINDS }).notNull(),
    mimeType: text("mime_type").notNull(),
    name: text().notNull(),
    size: integer().notNull(),
    importBatchId: text("import_batch_id").references(() => importBatch.id, {
      onDelete: "cascade",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("file_user_idx").on(t.userId), index("file_import_batch_idx").on(t.importBatchId)],
);
