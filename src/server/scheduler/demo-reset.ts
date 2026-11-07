import "server-only";
import { eq } from "drizzle-orm";
import { calendarDateInPrague, isDailyDue, timeInPrague } from "@/lib/number-format";
import { db } from "../db";
import { user } from "../db/schema";
import { demoUserId, isDemo } from "../demo/mode";
import { demoPasswordHash, seedDemoWith } from "../demo/seed";
import { purgeDemoAccount } from "../services/users";
import type { TickTask } from "./tick";

const RESET_AT = "03:30";
const SCHEDULER = { userId: null, source: "scheduler" } as const;

// The account's creation is the day key, so a restart never resets twice in one night.
function resetDue(now: Date, userId: string): boolean {
  if (!isDailyDue(now, RESET_AT)) return false;
  const created = db.select({ at: user.createdAt }).from(user).where(eq(user.id, userId)).get()?.at;
  if (!created) return true;
  const today = calendarDateInPrague(now);
  return calendarDateInPrague(created) !== today || timeInPrague(created) < RESET_AT;
}

export async function resetDemo(now: Date): Promise<{ userId: string; invoices: number }> {
  // Hashed first: from the purge to the new data nothing else gets the event loop.
  const hash = await demoPasswordHash();
  const current = demoUserId();
  if (current) purgeDemoAccount(SCHEDULER, current);
  return seedDemoWith(now, hash);
}

const RETRY_AFTER_MS = 3_600_000;

// Process memory: a seed that fails for a lasting reason is tried and reported once an hour,
// not on every tick. A restart may try once more early.
let failedAt: number | null = null;

async function attemptReset(now: Date): Promise<void> {
  if (failedAt !== null && now.getTime() - failedAt < RETRY_AFTER_MS) return;
  try {
    await resetDemo(now);
    failedAt = null;
  } catch (error) {
    failedAt = now.getTime();
    throw error;
  }
}

// A missing demo account is seeded at once, so a fresh demo volume needs no manual step.
export const demoResetTask: TickTask = {
  name: "demo-reset",
  async run(now) {
    if (!isDemo()) return;
    const current = demoUserId();
    if (!current || resetDue(now, current)) await attemptReset(now);
  },
};
