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

let running = false;
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

async function runJob(row: Job): Promise<void> {
  try {
    const definition = jobDefinition(row.kind);
    if (!definition) throw new Error(`Neznámý druh úlohy: ${row.kind}`);
    await definition.run(row);
    completeJob(row.id);
  } catch (error) {
    const later = error instanceof RetryLater;
    if (!later || exhausted(row)) reportFailure(error, failureContext(row));
    const reason = describe(error);
    if (exhausted(row)) {
      failJob(row.id, reason);
      return;
    }
    const delay = later ? error.delayMs : RETRY_DELAY_MS;
    retryJob(row.id, { runAt: new Date(clock.now().getTime() + delay), reason });
  }
}

export function recoverInterrupted(holder: string): void {
  const orphans = db
    .select()
    .from(job)
    .where(and(eq(job.status, "running"), or(isNull(job.lockedBy), ne(job.lockedBy, holder))))
    .all();
  for (const row of orphans) {
    const interrupted = "přerušený běh";
    try {
      const recover = jobDefinition(row.kind)?.recover;
      if (recover) recover(row);
      else if (exhausted(row)) {
        reportFailure(new Error("Úloha vyčerpala pokusy přerušeným během"), failureContext(row));
        failJob(row.id, interrupted);
      } else retryJob(row.id, { runAt: clock.now(), reason: interrupted });
    } catch (error) {
      reportFailure(error, failureContext(row));
      failJob(row.id, describe(error));
    }
  }
}

export async function drainJobs(worker: string): Promise<number> {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    while (worker !== halted) {
      const lease = acquireLease(worker);
      if (lease === "busy") break;
      if (lease === "taken_over") recoverInterrupted(worker);
      const next = claimNext(worker);
      if (!next) break;
      await runJob(next);
      done += 1;
    }
  } finally {
    running = false;
  }
  return done;
}

export function bindWorker(holder: string): void {
  shared.__fakturanKick = () => {
    drainJobs(holder).catch((error) => reportFailure(error, { task: "kick" }));
  };
}

// A drain in progress must not take the released lease back on its next job.
export function haltWorker(holder: string): void {
  halted = holder;
  shared.__fakturanKick = undefined;
}

export function kickWorker(): void {
  shared.__fakturanKick?.();
}
