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
import { recoverBackupJob, runBackup } from "../services/account-backup";
import { purgeStaleRestores, recoverRestore, runRestore } from "../services/account-restore";
import { purgeNotices } from "../services/bank-notices";
import { planBankPolls, pollMailbox } from "../services/bank-poll";
import { deliverDigest, planDigests } from "../services/due-alerts";
import { planRateFetch, runRateFetch } from "../services/exchange-rates";
import { runExport } from "../services/export-run";
import { purgeExpiredExports, recoverExportJob } from "../services/exports";
import { purgeStaleBatches, recoverImportJob } from "../services/import-batch";
import { runImportCommit } from "../services/import-commit";
import { runImportParse } from "../services/import-parse";
import { deliverOwnerReport, planOwnerReports } from "../services/owner-reports";
import { deliverMail, recoverMail, settleDeadMail } from "../services/mail-delivery";
import {
  deliverUserNotice,
  planRecurringNotices,
  planRecurringRuns,
  runRecurringJob,
  settleDeadRuns,
} from "../services/recurring-run";
import { planReminders } from "../services/reminders";
import { backupTask } from "./backup";
import { demoResetTask } from "./demo-reset";
import { releaseLease } from "./lease";
import { opsCheckTask } from "./ops-check";
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
    purgeNotices(now);
  },
};

const IMPORT_CLEANUP_MS = 3_600_000;
let importCleanedAt = 0;

export const importCleanupTask: TickTask = {
  name: "import-cleanup",
  run(now) {
    if (now.getTime() - importCleanedAt < IMPORT_CLEANUP_MS) return;
    importCleanedAt = now.getTime();
    purgeStaleBatches(now);
  },
};

const EXPORT_CLEANUP_MS = 3_600_000;
let exportCleanedAt = 0;

export const exportCleanupTask: TickTask = {
  name: "export-cleanup",
  run(now) {
    if (now.getTime() - exportCleanedAt < EXPORT_CLEANUP_MS) return;
    exportCleanedAt = now.getTime();
    purgeExpiredExports(now);
    purgeStaleRestores(now);
  },
};

export const deadMailTask: TickTask = { name: "dead-mail", run: () => settleDeadMail() };

export const deadRecurringTask: TickTask = { name: "dead-recurring", run: () => settleDeadRuns() };

export const recurringPlanTask: TickTask = { name: "recurring-plan", run: planRecurringRuns };

export const recurringNoticeTask: TickTask = {
  name: "recurring-notice",
  run: planRecurringNotices,
};

export const reminderPlanTask: TickTask = { name: "reminder-plan", run: planReminders };

export const digestPlanTask: TickTask = { name: "digest-plan", run: planDigests };

export const ownerReportPlanTask: TickTask = { name: "owner-report-plan", run: planOwnerReports };

export const fxPlanTask: TickTask = { name: "fx-plan", run: planRateFetch };

export const bankPollTask: TickTask = { name: "bank-poll", run: planBankPolls };

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
  registerJob("recurring.run", { run: runRecurringJob });
  registerJob("user.notice", { run: deliverUserNotice });
  registerJob("user.digest", { run: deliverDigest });
  registerJob("user.report", { run: deliverOwnerReport });
  registerJob("bank.poll", { run: pollMailbox });
  registerJob("fx.fetch", { run: runRateFetch });
  registerJob("import.parse", { run: runImportParse, recover: recoverImportJob });
  registerJob("import.commit", { run: runImportCommit, recover: recoverImportJob });
  registerJob("export.run", { run: runExport, recover: recoverExportJob });
  registerJob("backup.run", { run: runBackup, recover: recoverBackupJob });
  registerJob("restore.run", { run: runRestore, recover: recoverRestore });
  registerTickTask(deadMailTask);
  registerTickTask(deadRecurringTask);
  registerTickTask(recurringPlanTask);
  registerTickTask(recurringNoticeTask);
  registerTickTask(reminderPlanTask);
  registerTickTask(digestPlanTask);
  registerTickTask(ownerReportPlanTask);
  registerTickTask(bankPollTask);
  registerTickTask(fxPlanTask);
  registerTickTask(jobCleanupTask);
  registerTickTask(importCleanupTask);
  registerTickTask(exportCleanupTask);
  registerTickTask(backupTask);
  registerTickTask(opsCheckTask);
  registerTickTask(demoResetTask);
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
  // A job still running in either lane must not be recovered while it runs: the lease expires once
  // this process exits.
  if (!jobInFlight()) releaseLease(running.holder);
}
