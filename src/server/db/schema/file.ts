import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const FILE_KINDS = ["logo", "qr_logo", "signature", "sent_pdf"] as const;
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("file_user_idx").on(t.userId)],
);
