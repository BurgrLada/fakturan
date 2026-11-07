import "server-only";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { BankFailureCode } from "@/lib/bank-mailbox";
import { clock } from "../clock";
import { db } from "../db";
import { bankMailbox, job, notification, user } from "../db/schema";
import { scoped } from "../db/scoped";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { notify, resolveNotificationsOf } from "../services/notifications";

// Reading position and health, not a user's action: they change every 5 minutes for every
// mailbox, so they live outside services and leave no audit trail.

const SLOT_MS = 5 * 60_000;
const FAILURES_BEFORE_ALERT = 3;
const ALERT = "bank_connection_failed";

export type MailboxHandle = {
  userId: string;
  updatedAt: Date;
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
    if (changes > 0) resolveNotificationsOf(tx, mailbox.userId, ALERT);
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
    const open = tx
      .select({ id: notification.id })
      .from(notification)
      .where(
        scoped(mailbox.userId).where(notification, (t, { eq, and }) =>
          and(eq(t.kind, ALERT), isNull(t.resolvedAt)),
        ),
      )
      .get();
    if (open) return;
    // One outage is one row; the time makes a key that a resolved earlier outage cannot block.
    notify(tx, {
      userId: mailbox.userId,
      kind: ALERT,
      dedupeKey: `bank_connection:${clock.now().getTime()}`,
      params: { code },
    });
  });
}

function jobKey(userId: string, now: Date): string {
  return `bank:${userId}:${Math.floor(now.getTime() / SLOT_MS)}`;
}

// A poll still waiting already covers this slot, so a long stall cannot queue up a run per slot.
// A demo instance never logs into a mailbox left over from before DEMO_MODE was switched on.
export function enqueueDuePolls(now: Date): void {
  if (env.DEMO_MODE) return;
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
