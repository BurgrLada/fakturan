import "server-only";
import { eq } from "drizzle-orm";
import { clock } from "../clock";
import { db } from "../db";
import { schedulerState } from "../db/schema";
import { drainQueue, recoverInterrupted, startHeavy } from "../jobs/worker";
import { acquireLease } from "./lease";
import { reportFailure } from "./report";

export type TickTask = { name: string; run: (now: Date) => void | Promise<void> };

// Under the default 60 s interval, so a long queue cannot hold back the next tick and health.
const DRAIN_BUDGET_MS = 45_000;

const tasks = new Map<string, TickTask>();

export function registerTickTask(task: TickTask): void {
  tasks.set(task.name, task);
}

export function tickTasksForTests(): string[] {
  return [...tasks.keys()];
}

export function resetTickTasksForTests(): void {
  tasks.clear();
}

function stamp(fields: { lastTickAt: Date } | { lastOkAt: Date }): void {
  db.update(schedulerState).set(fields).where(eq(schedulerState.id, 1)).run();
}

function renewLease(holder: string): boolean {
  const lease = acquireLease(holder);
  if (lease === "taken_over") recoverInterrupted(holder);
  return lease !== "busy";
}

export async function tick(holder: string): Promise<{ ran: boolean }> {
  if (!renewLease(holder)) return { ran: false };
  const now = clock.now();
  stamp({ lastTickAt: now });
  let ok = true;
  for (const task of tasks.values()) {
    if (!renewLease(holder)) return { ran: true };
    try {
      await task.run(now);
    } catch (error) {
      ok = false;
      reportFailure(error, { task: task.name });
    }
  }
  // Not awaited: a long import or backup must not hold back the tick or the mail.
  startHeavy(holder);
  const queue = await drainQueue(holder, DRAIN_BUDGET_MS);
  if (ok && queue.ok) stamp({ lastOkAt: clock.now() });
  return { ran: true };
}
