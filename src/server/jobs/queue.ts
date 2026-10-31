import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, lt, sql, type SQL } from "drizzle-orm";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { job, user, type Job, type JobKind, type JobPayload } from "../db/schema";
import { scoped } from "../db/scoped";

export { JOB_KINDS, type Job, type JobKind, type JobPayload } from "../db/schema";

const DEFAULT_MAX_ATTEMPTS = 3;
const RETENTION_MS = 90 * 86_400_000;

type EnqueueInput = {
  kind: JobKind;
  key: string;
  userId: string | null;
  payload: JobPayload;
  runAt?: Date;
  maxAttempts?: number;
};

export function enqueue(tx: Tx, input: EnqueueInput): { id: string; created: boolean } {
  const now = clock.now();
  const inserted = tx
    .insert(job)
    .values({
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      key: input.key,
      payload: input.payload,
      runAt: input.runAt ?? now,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: job.key })
    .returning({ id: job.id })
    .get();
  if (inserted) return { id: inserted.id, created: true };
  const existing = tx.select({ id: job.id }).from(job).where(eq(job.key, input.key)).get();
  return { id: existing!.id, created: false };
}

export function claimNext(worker: string): Job | null {
  const now = clock.now();
  const claimed = db.transaction(
    (tx) => {
      const next = tx
        .select({ id: job.id })
        .from(job)
        .leftJoin(user, eq(job.userId, user.id))
        .where(
          and(
            eq(job.status, "pending"),
            sql`${job.runAt} <= ${now.getTime()}`,
            sql`coalesce(${user.banned}, 0) = 0`,
          ),
        )
        .orderBy(job.runAt, job.createdAt)
        .limit(1);
      return tx
        .update(job)
        .set({
          status: "running",
          lockedBy: worker,
          attempts: sql`${job.attempts} + 1`,
          updatedAt: now,
        })
        .where(eq(job.id, sql`(${next})`))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
  return claimed ?? null;
}

// Guarded on the holder, so a result arriving after recovery took the job over changes nothing.
function finishRunning(
  id: string,
  worker: string,
  fields: { status: Job["status"] | SQL; runAt?: Date; reason?: string | SQL },
) {
  db.update(job)
    .set({ ...fields, lockedBy: null, updatedAt: clock.now() })
    .where(and(eq(job.id, id), eq(job.status, "running"), eq(job.lockedBy, worker)))
    .run();
}

export function completeJob(id: string, worker: string): void {
  finishRunning(id, worker, { status: "done" });
}

const OWNER_BANNED = sql`EXISTS (
  SELECT 1 FROM "user" WHERE "user"."id" = "job"."user_id" AND coalesce("user"."banned", 0) = 1
)`;

// One statement, so a deactivation cannot slip between the check and the write (R-21).
export function retryJob(id: string, worker: string, input: { runAt: Date; reason: string }): void {
  finishRunning(id, worker, {
    status: sql`CASE WHEN ${OWNER_BANNED} THEN 'cancelled' ELSE 'pending' END`,
    runAt: input.runAt,
    reason: sql`CASE WHEN ${OWNER_BANNED} THEN 'deactivated' ELSE ${input.reason} END`,
  });
}

export function failJob(id: string, worker: string, reason: string): void {
  finishRunning(id, worker, { status: "dead", reason });
}

// A running attempt is left alone: it cannot be taken back (R-21).
export function cancelUserJobs(tx: Tx, userId: string): string[] {
  return tx
    .update(job)
    .set({ status: "cancelled", reason: "deactivated", updatedAt: clock.now() })
    .where(scoped(userId).where(job, (t, { eq }) => eq(t.status, "pending")))
    .returning({ id: job.id })
    .all()
    .map((row) => row.id);
}

// Deleting frees the key, so the same work can be enqueued again. A running attempt is left alone.
export function takeIdleJobs(tx: Tx, userId: string, keyPrefix: string): Job[] {
  return tx
    .delete(job)
    .where(
      scoped(userId).where(job, (t, { and }) =>
        and(inArray(t.status, ["pending", "cancelled"]), like(t.key, `${keyPrefix}%`)),
      ),
    )
    .returning()
    .all();
}

// False when the job is no longer dead, so two settlers cannot both act on it.
export function removeDeadJob(tx: Tx, userId: string, id: string): boolean {
  const removed = tx
    .delete(job)
    .where(scoped(userId).where(job, (t, { and, eq }) => and(eq(t.id, id), eq(t.status, "dead"))))
    .run();
  return removed.changes > 0;
}

// Dead jobs stay for diagnosis. Past this age recurring_run, reminder_sent and email_log hold idempotency.
export function purgeFinishedJobs(now: Date): void {
  db.delete(job)
    .where(
      and(
        inArray(job.status, ["done", "cancelled"]),
        lt(job.updatedAt, new Date(now.getTime() - RETENTION_MS)),
      ),
    )
    .run();
}
