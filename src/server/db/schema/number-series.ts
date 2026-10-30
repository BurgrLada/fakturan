import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { DOCUMENT_TYPES, RESET_PERIODS } from "@/lib/number-format";
import { user } from "./auth";

export const numberSeries = sqliteTable(
  "number_series",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    documentType: text("document_type", { enum: DOCUMENT_TYPES }).notNull(),
    template: text().notNull(),
    reset: text({ enum: RESET_PERIODS }).notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("number_series_user_idx").on(t.userId),
    uniqueIndex("number_series_default_idx")
      .on(t.userId, t.documentType)
      .where(sql`is_default = 1`),
  ],
);

// No cascade from the series: losing a counter would hand out its numbers a second time.
export const numberSeriesCounter = sqliteTable(
  "number_series_counter",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => numberSeries.id),
    periodKey: text("period_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    next: integer().notNull(),
    // Separate from next: setNextNumber may jump, and only allocated numbers block going back.
    highest: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.periodKey] }),
    index("number_series_counter_user_idx").on(t.userId),
  ],
);
