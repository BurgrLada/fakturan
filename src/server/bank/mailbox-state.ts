import "server-only";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { BankFailureCode } from "@/lib/bank-mailbox";
import { clock } from "../clock";
import { db } from "../db";
import { bankMailbox, job, user } from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue } from "../jobs/queue";
import { notify, resolveNotification } from "../services/notifications";

// Reading position and health, not a user's action: they change every 5 minutes for every
// mailbox, so they live outside services and leave no audit trail.

const SLOT_MS = 5 * 60_000;
const FAILURES_BEFORE_ALERT = 3;

export type MailboxHandle = {
  userId: string;
  updatedAt: Date;
  lastSuccessAt: Date | null;
};

// updated_at moves only when the user saves the settings, and a save may have pointed the
// mailbox elsewhere: a poll still running must then not write the old position back.
function current({ userId, updatedAt }: MailboxHandle) {
  return scoped(userId).where(bankMailbox, (t, { eq }) => eq(t.updatedAt, updatedAt));
}

export function startCursor(
  mailbox: MailboxHandle,
  position: { uidValidity: number; lastUid: number | null; firstReadAt: Date },
): void {
  db.update(bankMailbox).set(position).where(current(mailbox)).run();
}

export function moveCursor(mailbox: MailboxHandle, lastUid: number): void {
  db.update(bankMailbox).set({ lastUid }).where(current(mailbox)).run();
}

// Stable for the whole outage, so that repeated failures stay one notification, and new after
// each success, so that the next outage does not hit the resolved row of the previous one.
function alertKey({ lastSuccessAt }: MailboxHandle): string {
  return `bank_connection:${lastSuccessAt?.getTime() ?? "never"}`;
}

export function recordSuccess(mailbox: MailboxHandle, lastNoticeAt: Date | null): void {
  const now = clock.now();
  db.transaction((tx) => {
    const { changes } = tx
      .update(bankMailbox)
      .set({
        lastCheckAt: now,
        lastSuccessAt: now,
        ...(lastNoticeAt ? { lastNoticeAt } : {}),
        failureCode: null,
        failures: 0,
      })
      .where(current(mailbox))
      .run();
    if (changes > 0) resolveNotification(tx, mailbox.userId, alertKey(mailbox));
  });
}

export function recordFailure(
  mailbox: MailboxHandle,
  code: BankFailureCode,
  lastNoticeAt: Date | null = null,
): void {
  db.transaction((tx) => {
    const row = tx
      .update(bankMailbox)
      .set({
        lastCheckAt: clock.now(),
        ...(lastNoticeAt ? { lastNoticeAt } : {}),
        failureCode: code,
        failures: sql`${bankMailbox.failures} + 1`,
      })
      .where(current(mailbox))
      .returning({ failures: bankMailbox.failures })
      .get();
    if (!row || row.failures < FAILURES_BEFORE_ALERT) return;
    notify(tx, {
      userId: mailbox.userId,
      kind: "bank_connection_failed",
      dedupeKey: alertKey(mailbox),
      params: { code },
    });
  });
}

function jobKey(userId: string, now: Date): string {
  return `bank:${userId}:${Math.floor(now.getTime() / SLOT_MS)}`;
}

// A poll still waiting already covers this slot, so a long stall cannot queue up a run per slot.
export function enqueueDuePolls(now: Date): void {
  const busy = db
    .select({ userId: job.userId })
    .from(job)
    .where(
      and(
        eq(job.kind, "bank.poll"),
        inArray(job.status, ["pending", "running"]),
        isNotNull(job.userId),
      ),
    );
  const accounts = db
    .select({ userId: bankMailbox.userId })
    .from(bankMailbox)
    .innerJoin(user, eq(user.id, bankMailbox.userId))
    .where(
      and(
        eq(bankMailbox.enabled, true),
        sql`coalesce(${user.banned}, 0) = 0`,
        notInArray(bankMailbox.userId, sql`${busy}`),
      ),
    )
    .all();
  for (const { userId } of accounts) {
    db.transaction((tx) =>
      enqueue(tx, { kind: "bank.poll", key: jobKey(userId, now), userId, payload: {} }),
    );
  }
}
