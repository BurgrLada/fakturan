import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { EXPORT_FORMATS, EXPORT_KINDS, type ExportFilter } from "@/lib/export-filter";
import { user } from "./auth";
import { file } from "./file";

export const EXPORT_STATUSES = ["queued", "running", "done", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export {
  EXPORT_FORMATS,
  EXPORT_KINDS,
  type ExportFormat,
  type ExportKind,
} from "@/lib/export-filter";

// The result is a file of the account; the row outlives it as a record that the export ran (R-23).
export const exportJob = sqliteTable(
  "export_job",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text({ enum: EXPORT_KINDS }).notNull(),
    format: text({ enum: EXPORT_FORMATS }).notNull(),
    filter: text({ mode: "json" }).$type<ExportFilter>().notNull(),
    status: text({ enum: EXPORT_STATUSES }).notNull().default("queued"),
    progress: integer().notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    fileId: text("file_id").references(() => file.id, { onDelete: "set null" }),
    reason: text(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("export_job_user_idx").on(t.userId, t.createdAt),
    index("export_job_status_idx").on(t.status, t.expiresAt),
  ],
);

export type ExportJob = typeof exportJob.$inferSelect;
