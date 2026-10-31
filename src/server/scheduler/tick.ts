import "server-only";
import { eq } from "drizzle-orm";
import { clock } from "../clock";
import { db } from "../db";
import { schedulerState } from "../db/schema";
import { drainJobs, recoverInterrupted } from "../jobs/worker";
import { acquireLease } from "./lease";
import { reportFailure } from "./report";

export type TickTask = { name: string; run: (now: Date) => void | Promise<void> };

const tasks = new Map<string, TickTask>();

export function registerTickTask(task: TickTask): void {
  tasks.set(task.name, task);
}

export function resetTickTasksForTests(): void {
  tasks.clear();
}

function stamp(fields: { lastTickAt: Date } | { lastOkAt: Date }): void {
  db.update(schedulerState).set(fields).where(eq(schedulerState.id, 1)).run();
}

export async function tick(holder: string): Promise<{ ran: boolean }> {
  const lease = acquireLease(holder);
  if (lease === "busy") return { ran: false };
  if (lease === "taken_over") recoverInterrupted(holder);
  const now = clock.now();
  stamp({ lastTickAt: now });
  for (const task of tasks.values()) {
    try {
      await task.run(now);
    } catch (error) {
      reportFailure(error, { task: task.name });
    }
  }
  await drainJobs(holder);
  stamp({ lastOkAt: clock.now() });
  return { ran: true };
}
