import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const IMPORT_KINDS = ["isdoc", "tabular"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_BATCH_STATUSES = [
  "uploading",
  "mapping",
  "parsing",
  "ready",
  "committing",
  "done",
  "failed",
  "undone",
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const MAPPING_TARGETS = ["customers", "catalog", "invoices"] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];

// An undone batch stays for the audit trail; only undoBatch removes what it created (R-20).
export const importBatch = sqliteTable(
  "import_batch",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text({ enum: IMPORT_KINDS }).notNull(),
    status: text({ enum: IMPORT_BATCH_STATUSES }).notNull().default("uploading"),
    target: text({ enum: MAPPING_TARGETS }),
    sourceSystem: text("source_system"),
    mapping: text({ mode: "json" }).$type<Record<string, unknown>>(),
    uploadedBytes: integer("uploaded_bytes").notNull().default(0),
    progress: integer().notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    // Moves with every preview edit, so a stale tab cannot confirm what it no longer shows.
    revision: integer().notNull().default(0),
    summary: text({ mode: "json" }).$type<Record<string, number>>(),
    error: text(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    committedAt: integer("committed_at", { mode: "timestamp_ms" }),
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("import_batch_user_idx").on(t.userId, t.createdAt),
    index("import_batch_status_idx").on(t.status, t.updatedAt),
  ],
);

export type ImportBatch = typeof importBatch.$inferSelect;

// Only the column mapping: a preset never carries data from the file it was made on.
export const mappingPreset = sqliteTable(
  "mapping_preset",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    target: text({ enum: MAPPING_TARGETS }).notNull(),
    mapping: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("mapping_preset_user_name_idx").on(t.userId, t.target, t.name)],
);
