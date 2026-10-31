import "server-only";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { clock } from "../clock";
import { db } from "../db";
import { job, type Job } from "../db/schema";
import { scrubText } from "../monitoring/before-send";
import { acquireLease } from "../scheduler/lease";
import { reportFailure } from "../scheduler/report";
import { claimNext, completeJob, failJob, retryJob } from "./queue";
import { jobDefinition, RetryLater } from "./registry";

const RETRY_DELAY_MS = 5 * 60_000;

// The app and instrumentation are separate bundles with separate module state, so a route reaches
// the one worker through globalThis.
const shared = globalThis as typeof globalThis & { __fakturanKick?: () => void };

let draining = false;
let inFlight = false;
let halted: string | null = null;

function failureContext(row: Job) {
  return {
    task: "job",
    jobId: row.id,
    kind: row.kind,
    ...(row.userId ? { userId: row.userId } : {}),
  };
}

function describe(error: unknown): string {
  return scrubText(error instanceof Error ? error.message : String(error));
}

function exhausted(row: Job): boolean {
  return row.attempts >= row.maxAttempts;
}

function settleFailure(row: Job, worker: string, error: unknown): void {
  const later = error instanceof RetryLater;
  const dead = exhausted(row);
  if (later ? dead && error.report : true) reportFailure(error, failureContext(row));
  const reason = describe(error);
  if (dead) {
    failJob(row.id, worker, reason);
    return;
  }
  const delay = later ? error.delayMs : RETRY_DELAY_MS;
  retryJob(row.id, worker, { runAt: new Date(clock.now().getTime() + delay), reason });
}

async function runJob(row: Job, worker: string): Promise<void> {
  try {
    const definition = jobDefinition(row.kind);
    if (!definition) throw new Error(`Neznámý druh úlohy: ${row.kind}`);
    await definition.run(row);
  } catch (error) {
    settleFailure(row, worker, error);
    return;
  }
  // Outside the try above: the work is done, so a failed write must not schedule it again.
  try {
    completeJob(row.id, worker);
  } catch (error) {
    reportFailure(error, failureContext(row));
  }
}

// Adopting first makes a late result from the previous holder a no-op during recover too.
function adoptOrphans(holder: string): Job[] {
  return db
    .update(job)
    .set({ lockedBy: holder, updatedAt: clock.now() })
    .where(and(eq(job.status, "running"), or(isNull(job.lockedBy), ne(job.lockedBy, holder))))
    .returning()
    .all();
}

export function recoverInterrupted(holder: string): void {
  for (const row of adoptOrphans(holder)) {
    const interrupted = "přerušený běh";
    try {
      const recover = jobDefinition(row.kind)?.recover;
      if (recover) recover(row);
      else if (exhausted(row)) {
        reportFailure(new Error("Úloha vyčerpala pokusy přerušeným během"), failureContext(row));
        failJob(row.id, holder, interrupted);
      } else retryJob(row.id, holder, { runAt: clock.now(), reason: interrupted });
    } catch (error) {
      reportFailure(error, failureContext(row));
      failJob(row.id, holder, describe(error));
    }
  }
}

// `ok` says the queue was really served: false when another drain, a lost lease or a halt stopped it.
export async function drainQueue(
  worker: string,
  budgetMs = Infinity,
): Promise<{ done: number; ok: boolean }> {
  if (draining) return { done: 0, ok: false };
  draining = true;
  const deadline = clock.now().getTime() + budgetMs;
  let done = 0;
  try {
    while (clock.now().getTime() < deadline) {
      if (worker === halted) return { done, ok: false };
      const lease = acquireLease(worker);
      if (lease === "busy") return { done, ok: false };
      if (lease === "taken_over") recoverInterrupted(worker);
      const next = claimNext(worker);
      if (!next) break;
      inFlight = true;
      try {
        await runJob(next, worker);
      } finally {
        inFlight = false;
      }
      done += 1;
    }
  } finally {
    draining = false;
  }
  return { done, ok: true };
}

export async function drainJobs(worker: string): Promise<number> {
  return (await drainQueue(worker)).done;
}

export function jobInFlight(): boolean {
  return inFlight;
}

export function bindWorker(holder: string): void {
  shared.__fakturanKick = () => {
    drainJobs(holder).catch((error) => reportFailure(error, { task: "kick" }));
  };
}

// A drain in progress must not renew the lease for its next job.
export function haltWorker(holder: string): void {
  halted = holder;
  shared.__fakturanKick = undefined;
}

export function kickWorker(): void {
  shared.__fakturanKick?.();
}
