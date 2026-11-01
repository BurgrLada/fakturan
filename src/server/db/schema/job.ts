import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const JOB_KINDS = [
  "mail.send",
  "recurring.run",
  "user.notice",
  "user.digest",
  "bank.poll",
  "fx.fetch",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["pending", "running", "done", "dead", "cancelled"] as const;

// IDs and plain data only: addresses, subjects and secrets never enter the queue.
export type JobPayload = Record<string, string | number | boolean | null>;

export const job = sqliteTable(
  "job",
  {
    id: text().primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    kind: text({ enum: JOB_KINDS }).notNull(),
    key: text().notNull().unique(),
    payload: text({ mode: "json" }).$type<JobPayload>().notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default("pending"),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    lockedBy: text("locked_by"),
    reason: text(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("job_status_run_at_idx").on(t.status, t.runAt), index("job_user_idx").on(t.userId)],
);

export type Job = typeof job.$inferSelect;

export const schedulerState = sqliteTable("scheduler_state", {
  id: integer().primaryKey(),
  holder: text(),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  lastTickAt: integer("last_tick_at", { mode: "timestamp_ms" }),
  lastOkAt: integer("last_ok_at", { mode: "timestamp_ms" }),
  lastBackupAt: integer("last_backup_at", { mode: "timestamp_ms" }),
  lastBackupTryAt: integer("last_backup_try_at", { mode: "timestamp_ms" }),
});
