import "server-only";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import { clock } from "../clock";
import { db, type Db } from "../db";
import { schedulerState } from "../db/schema";
import { env } from "../env";
import { purgeFinishedJobs } from "../jobs/queue";
import { registerJob } from "../jobs/registry";
import { bindWorker, haltWorker, jobInFlight } from "../jobs/worker";
import { deliverMail, recoverMail, settleDeadMail } from "../services/mail-delivery";
import { backupTask } from "./backup";
import { releaseLease } from "./lease";
import { reportFailure } from "./report";
import { registerTickTask, tick, type TickTask } from "./tick";

export type SchedulerHealth = "not_started" | "starting" | "running" | "stale";

const STALE_MS = 5 * 60_000;
const CLEANUP_AT = "03:30";

type Running = { cron: Cron; holder: string; onTerm: () => void };

// next dev re-evaluates instrumentation, and a second cron would fight the first over the lease.
const shared = globalThis as typeof globalThis & { __fakturanScheduler?: Running };

let cleanedOn: CalendarDate | null = null;

export const jobCleanupTask: TickTask = {
  name: "job-cleanup",
  run(now) {
    const today = calendarDateInPrague(now);
    if (cleanedOn === today || !isDailyDue(now, CLEANUP_AT)) return;
    cleanedOn = today;
    purgeFinishedJobs(now);
  },
};

export const deadMailTask: TickTask = { name: "dead-mail", run: () => settleDeadMail() };

export function cronPattern(seconds: number): string {
  return `*/${seconds} * * * * *`;
}

export function schedulerHealth(q: Pick<Db, "$client">): SchedulerHealth {
  let row: { started_at: number | null; last_tick_at: number | null } | undefined;
  try {
    row = q.$client
      .prepare("SELECT started_at, last_tick_at FROM scheduler_state WHERE id = 1")
      .get() as typeof row;
  } catch {
    return "not_started";
  }
  if (row?.started_at == null) return "not_started";
  const age = clock.now().getTime() - (row.last_tick_at ?? row.started_at);
  if (age > STALE_MS) return "stale";
  return row.last_tick_at == null ? "starting" : "running";
}

export function startScheduler(): void {
  if (shared.__fakturanScheduler) return;
  const holder = randomUUID();
  const startedAt = clock.now();
  // A tick left by the previous process must not read as stale right after a long outage.
  db.insert(schedulerState)
    .values({ id: 1, startedAt })
    .onConflictDoUpdate({ target: schedulerState.id, set: { startedAt, lastTickAt: null } })
    .run();
  registerJob("mail.send", { run: deliverMail, recover: recoverMail });
  registerTickTask(deadMailTask);
  registerTickTask(jobCleanupTask);
  registerTickTask(backupTask);
  bindWorker(holder);
  const cron = new Cron(cronPattern(env.SCHEDULER_TICK_SECONDS), { protect: true }, async () => {
    await tick(holder).catch((error) => reportFailure(error, { task: "tick" }));
  });
  // Next.js exits from its own SIGTERM handler, so the lease must go first.
  const onTerm = () => stopScheduler();
  process.prependOnceListener("SIGTERM", onTerm);
  shared.__fakturanScheduler = { cron, holder, onTerm };
}

export function stopScheduler(): void {
  const running = shared.__fakturanScheduler;
  if (!running) return;
  shared.__fakturanScheduler = undefined;
  running.cron.stop();
  process.off("SIGTERM", running.onTerm);
  haltWorker(running.holder);
  // A job still running must not be recovered while it runs: the lease expires once this process exits.
  if (!jobInFlight()) releaseLease(running.holder);
}
