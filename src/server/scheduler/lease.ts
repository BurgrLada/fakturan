import "server-only";
import { and, eq } from "drizzle-orm";
import { clock } from "../clock";
import { db } from "../db";
import { schedulerState } from "../db/schema";

// Containers overlap over one volume during a redeploy, even though a single process runs (R-5).
const LEASE_MS = 120_000;
const STATE_ID = 1;

export type LeaseResult = "held" | "taken_over" | "busy";

export function acquireLease(holder: string): LeaseResult {
  const now = clock.now();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  return db.transaction(
    (tx) => {
      const state = tx.select().from(schedulerState).where(eq(schedulerState.id, STATE_ID)).get();
      const mine = state?.holder === holder;
      if (!mine && state?.holder && state.leaseUntil && state.leaseUntil > now) return "busy";
      tx.insert(schedulerState)
        .values({ id: STATE_ID, holder, leaseUntil })
        .onConflictDoUpdate({ target: schedulerState.id, set: { holder, leaseUntil } })
        .run();
      return mine ? "held" : "taken_over";
    },
    { behavior: "immediate" },
  );
}

export function releaseLease(holder: string): void {
  db.update(schedulerState)
    .set({ holder: null, leaseUntil: null })
    .where(and(eq(schedulerState.id, STATE_ID), eq(schedulerState.holder, holder)))
    .run();
}
