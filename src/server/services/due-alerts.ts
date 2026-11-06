import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { addDays, AWAITING_PAYMENT, isOverdue } from "@/lib/invoice";
import type { Alert } from "@/lib/automation";
import { formatMoney } from "@/lib/money";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { db } from "../db";
import type { Reader } from "./access";
import { automationSettings, invoice, job, user, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue } from "../jobs/queue";
import { RetryLater } from "../jobs/registry";
import { reportFailure } from "../scheduler/report";
import { resolveTransport } from "./mail-settings";
import { mutate } from "./mutation";
import { registerDerivedAlerts } from "./notifications";
import { getPreferences } from "./preferences";
import { remindersForReview } from "./reminders";

export const DUE_SOON_DAYS = 3;

const DIGEST_RETRY_MS = 30 * 60_000;

const T = TEXTS.reminders.digest;

export type AlertRow = {
  id: string;
  number: string | null;
  customerName: string;
  dueDate: CalendarDate;
  amountDueMinor: number;
  currency: typeof invoice.$inferSelect.currency;
};

export function dueAlerts(
  ownerId: string,
  today: CalendarDate,
  q: Reader = db,
): { overdue: AlertRow[]; dueSoon: AlertRow[] } {
  const rows = q
    .select({
      id: invoice.id,
      status: invoice.status,
      number: invoice.number,
      customerName: invoice.customerName,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      creditsMinor: invoice.creditsMinor,
      advanceMinor: invoice.advanceMinor,
      supersededAt: invoice.supersededAt,
    })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        and(inArray(t.status, [...AWAITING_PAYMENT]), isNotNull(t.dueDate)),
      ),
    )
    .orderBy(invoice.dueDate)
    .all()
    .filter((row) => amountDue(row) > 0);

  const toRow = (row: (typeof rows)[number]): AlertRow => ({
    id: row.id,
    number: row.number,
    customerName: row.customerName,
    dueDate: row.dueDate!,
    amountDueMinor: amountDue(row),
    currency: row.currency,
  });
  const limit = addDays(today, DUE_SOON_DAYS);
  return {
    overdue: rows.filter((row) => isOverdue(row, today)).map(toRow),
    dueSoon: rows.filter((row) => row.dueDate! >= today && row.dueDate! <= limit).map(toRow),
  };
}

function displayDate(ownerId: string, date: CalendarDate): string {
  return formatCalendarDate(date, getPreferences(ownerId).dateFormat);
}

// Computed on every read and never stored, so a paid invoice simply drops out (R-26). Each alert
// summarises its group, and the key carries the date so no list can pin an old day's text.
function alertsFor(ownerId: string, today: CalendarDate): Alert[] {
  const { overdue, dueSoon } = dueAlerts(ownerId, today);
  const review = remindersForReview(ownerId, today).length;
  const alerts: Alert[] = [];
  if (overdue[0]) {
    alerts.push({
      dedupeKey: `invoices:overdue:${today}`,
      kind: "invoices_overdue",
      params: { count: overdue.length, oldest: displayDate(ownerId, overdue[0].dueDate) },
    });
  }
  if (dueSoon[0]) {
    alerts.push({
      dedupeKey: `invoices:due-soon:${today}`,
      kind: "invoices_due_soon",
      params: {
        count: dueSoon.length,
        days: DUE_SOON_DAYS,
        nearest: displayDate(ownerId, dueSoon[0].dueDate),
      },
    });
  }
  if (review > 0) {
    alerts.push({
      dedupeKey: `reminders:review:${today}`,
      kind: "reminder_missed",
      params: { count: review },
    });
  }
  return alerts;
}

registerDerivedAlerts(alertsFor);

function digestAccounts() {
  return db
    .select({ userId: automationSettings.userId, sendTime: automationSettings.sendTime })
    .from(automationSettings)
    .innerJoin(user, eq(user.id, automationSettings.userId))
    .where(and(eq(automationSettings.dailyDigest, true), sql`coalesce(${user.banned}, 0) = 0`))
    .all();
}

function planDigest(userId: string, today: CalendarDate): void {
  const key = `digest:${userId}:${today}`;
  const planned = db
    .select({ id: job.id })
    .from(job)
    .where(scoped(userId).where(job, (t, ops) => ops.eq(t.key, key)))
    .get();
  if (planned) return;
  const { overdue, dueSoon } = dueAlerts(userId, today);
  if (overdue.length + dueSoon.length === 0) return;
  mutate({ userId, source: "scheduler" }, "mail.digest_plan", (tx, audit) => {
    enqueue(tx, { kind: "user.digest", key, userId, payload: { date: today } });
    audit({ entity: "automation", entityId: userId, ownerId: userId, scope: "user" });
  });
}

// Runs under the master switch as well: this message goes to the account owner alone (R-27).
export function planDigests(now: Date): void {
  const today = calendarDateInPrague(now);
  for (const { userId, sendTime } of digestAccounts()) {
    if (!isDailyDue(now, sendTime)) continue;
    try {
      planDigest(userId, today);
    } catch (error) {
      reportFailure(error, { task: "digest-plan", userId });
    }
  }
}

function digestText(ownerId: string, { overdue, dueSoon }: ReturnType<typeof dueAlerts>): string {
  const line = (row: AlertRow) =>
    [
      `- ${row.number ?? ""}`,
      row.customerName,
      displayDate(ownerId, row.dueDate),
      formatMoney(row.amountDueMinor, row.currency),
    ].join(", ");
  const section = (title: string, rows: AlertRow[]) =>
    rows.length > 0 ? [title, ...rows.map(line), ""] : [];
  return [...section(T.overdue, overdue), ...section(T.dueSoon, dueSoon)].join("\n").trim();
}

export async function deliverDigest(row: Job): Promise<void> {
  const userId = row.userId;
  if (!userId) throw new Error("Denní přehled nemá vlastníka");
  const account = db.select({ email: user.email }).from(user).where(eq(user.id, userId)).get();
  const settings = db
    .select({ dailyDigest: automationSettings.dailyDigest })
    .from(automationSettings)
    .where(scoped(userId).where(automationSettings))
    .get();
  if (!account || !settings?.dailyDigest) return;
  const alerts = dueAlerts(userId, String(row.payload.date));
  if (alerts.overdue.length + alerts.dueSoon.length === 0) return;
  const transport = await resolveTransport(userId);
  if (!transport) return;
  const { from, replyTo } = transport.identity;
  try {
    // Without the account's standing copies: this message is for the owner alone.
    await transport.send({
      from,
      ...(replyTo ? { replyTo } : {}),
      to: account.email,
      subject: T.subject,
      text: digestText(userId, alerts),
    });
  } catch {
    throw new RetryLater("Denní přehled se zopakuje", DIGEST_RETRY_MS);
  }
  mutate({ userId, source: "scheduler" }, "mail.digest", (_tx, audit) =>
    audit({
      entity: "automation",
      entityId: userId,
      ownerId: userId,
      scope: "user",
      after: { overdue: alerts.overdue.length, dueSoon: alerts.dueSoon.length },
    }),
  );
}
