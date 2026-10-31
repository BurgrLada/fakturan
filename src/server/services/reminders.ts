import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { addDays } from "@/lib/invoice";
import { mailMessageSchema, type SendInput } from "@/lib/mail-send";
import {
  calendarDateInPrague,
  isCalendarDate,
  isDailyDue,
  type CalendarDate,
} from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import {
  dueStage,
  isEligibleForReminder,
  MANUAL_STAGE,
  MAX_REMINDER_RULES,
  MAX_SNOOZE_DAYS,
  reminderRuleSchema,
  stageDate,
  stageForReview,
  type ReminderRule,
} from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  automationSettings,
  customer,
  invoice,
  notification,
  reminderRule,
  reminderSent,
  user,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { RATE_RULES } from "../rate-limit";
import { reportFailure } from "../scheduler/report";
import { enforceRateLimit, ServiceError, type Reader } from "./access";
import { automaticSendAllowed, getAutomation } from "./automation";
import { composeMail } from "./email-templates";
import { queueMail, queueReminder, sendPrefill, type SendPrefill } from "./invoice-mail";
import { findOwned, getInvoice, unlessUnchanged, Unchanged } from "./invoices";
import { mutate, type Audit } from "./mutation";
import { notify } from "./notifications";

const E = TEXTS.reminders.errors;

const REMINDER_COLUMNS = {
  id: invoice.id,
  type: invoice.type,
  status: invoice.status,
  number: invoice.number,
  customerName: invoice.customerName,
  currency: invoice.currency,
  dueDate: invoice.dueDate,
  totalMinor: invoice.totalMinor,
  paidMinor: invoice.paidMinor,
  remindersOff: invoice.remindersOff,
  remindersPartial: invoice.remindersPartial,
  remindersSnoozeUntil: invoice.remindersSnoozeUntil,
  remindersEnabled: customer.remindersEnabled,
};

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

const schedulerActor = (userId: string): Actor => ({ userId, source: "scheduler" });

export function listReminderRules(ownerId: string, q: Reader = db): ReminderRule[] {
  return q
    .select({ id: reminderRule.id, offsetDays: reminderRule.offsetDays, texts: reminderRule.texts })
    .from(reminderRule)
    .where(scoped(ownerId).where(reminderRule))
    .orderBy(reminderRule.position)
    .all();
}

function renumberRules(tx: Tx, userId: string): void {
  const ordered = tx
    .select({ id: reminderRule.id })
    .from(reminderRule)
    .where(scoped(userId).where(reminderRule))
    .orderBy(reminderRule.offsetDays)
    .all();
  ordered.forEach(({ id }, position) => {
    tx.update(reminderRule)
      .set({ position })
      .where(scoped(userId).where(reminderRule, (t, ops) => ops.eq(t.id, id)))
      .run();
  });
}

function readRule(q: Reader, userId: string, id: string) {
  return q
    .select()
    .from(reminderRule)
    .where(scoped(userId).where(reminderRule, (t, ops) => ops.eq(t.id, id)))
    .get();
}

function assertOffsetFree(tx: Tx, userId: string, offsetDays: number, id?: string): void {
  const taken = tx
    .select({ id: reminderRule.id })
    .from(reminderRule)
    .where(scoped(userId).where(reminderRule, (t, ops) => ops.eq(t.offsetDays, offsetDays)))
    .get();
  if (taken && taken.id !== id) throw new ServiceError(E.duplicate);
}

export function saveReminderRule(actor: Actor, raw: unknown): { id: string } {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.mailSaveUser);
  const parsed = reminderRuleSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  const { id: existingId, offsetDays } = parsed.data;
  const given = parsed.data.texts;
  const texts = given && (given.cs || given.en) ? given : null;

  return mutate(actor, "reminder_rule.save", (tx, audit) => {
    const before = existingId ? readRule(tx, userId, existingId) : undefined;
    if (existingId && !before) throw new ServiceError(E.notFound);
    assertOffsetFree(tx, userId, offsetDays, existingId);
    const now = clock.now();
    const id = existingId ?? randomUUID();
    if (before) {
      tx.update(reminderRule)
        .set({ offsetDays, texts, updatedAt: now })
        .where(scoped(userId).where(reminderRule, (t, ops) => ops.eq(t.id, id)))
        .run();
    } else {
      if (listReminderRules(userId, tx).length >= MAX_REMINDER_RULES) {
        throw new ServiceError(E.tooMany);
      }
      tx.insert(reminderRule)
        .values({ id, userId, position: 0, offsetDays, texts, createdAt: now, updatedAt: now })
        .run();
    }
    renumberRules(tx, userId);
    audit({
      entity: "reminder_rule",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: before && { offsetDays: before.offsetDays, texts: before.texts },
      after: { offsetDays, texts },
    });
    return { id };
  });
}

export function deleteReminderRule(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "reminder_rule.delete", (tx, audit) => {
    const before = readRule(tx, userId, id);
    if (!before) throw new ServiceError(E.notFound);
    tx.delete(reminderRule)
      .where(scoped(userId).where(reminderRule, (t, ops) => ops.eq(t.id, id)))
      .run();
    renumberRules(tx, userId);
    audit({
      entity: "reminder_rule",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { offsetDays: before.offsetDays, texts: before.texts },
    });
  });
}

function sentStagesOf(q: Reader, userId: string, invoiceId: string): string[] {
  return q
    .select({ stageKey: reminderSent.stageKey })
    .from(reminderSent)
    .where(scoped(userId).where(reminderSent, (t, ops) => ops.eq(t.invoiceId, invoiceId)))
    .all()
    .map((row) => row.stageKey);
}

function insertSent(
  tx: Tx,
  userId: string,
  invoiceId: string,
  stageKey: string,
  trigger: "automatic" | "manual",
  emailLogId: string,
): boolean {
  const row = tx
    .insert(reminderSent)
    .values({
      id: randomUUID(),
      userId,
      invoiceId,
      stageKey,
      trigger,
      emailLogId,
      createdAt: clock.now(),
    })
    .onConflictDoNothing()
    .returning({ id: reminderSent.id })
    .get();
  return row !== undefined;
}

function chosenRule(q: Reader, userId: string, stageKey: string | null) {
  if (stageKey === null) return null;
  const rule = readRule(q, userId, stageKey);
  if (!rule) throw new ServiceError(E.notFound);
  return rule;
}

export function reminderPrefill(
  ownerId: string,
  invoiceId: string,
  stageKey: string | null,
): SendPrefill {
  const row = getInvoice(ownerId, invoiceId);
  if (!row) throw new ServiceError(TEXTS.invoiceMail.errors.notFound);
  if (amountDue(row) <= 0) throw new ServiceError(E.nothingDue);
  const rule = chosenRule(db, ownerId, stageKey);
  const prefill = sendPrefill(ownerId, invoiceId, undefined, {
    kind: "reminder",
    texts: rule?.texts ?? null,
  });
  const repeat = sentStagesOf(db, ownerId, invoiceId).includes(stageKey ?? MANUAL_STAGE);
  return { ...prefill, repeat };
}

export function sendManualReminder(
  actor: Actor,
  invoiceId: string,
  raw: SendInput & { stageKey: string | null; confirmedRepeat: boolean },
): { logId: string } {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.sendUser);
  const { stageKey, confirmedRepeat, ...message } = raw;
  if (stageKey !== null && typeof stageKey !== "string") throw new ServiceError(E.invalid);
  chosenRule(db, userId, stageKey);
  const stage = stageKey ?? MANUAL_STAGE;
  return queueReminder(actor, invoiceId, message, (tx, _row, logId) => {
    if (confirmedRepeat !== true && sentStagesOf(tx, userId, invoiceId).includes(stage)) {
      throw new ServiceError(E.confirmRepeat);
    }
    insertSent(tx, userId, invoiceId, stage, "manual", logId);
  });
}

function changeInvoice(
  actor: Actor,
  invoiceId: string,
  action: `invoice.${string}`,
  field: "remindersOff" | "remindersPartial" | "remindersSnoozeUntil",
  value: boolean | CalendarDate | null,
): void {
  const userId = ownerOf(actor);
  unlessUnchanged(() =>
    mutate(actor, action, (tx, audit) => {
      const before = findOwned(tx, userId, invoiceId);
      if (before[field] === value) throw new Unchanged(undefined);
      tx.update(invoice)
        .set({ [field]: value })
        .where(scoped(userId).where(invoice, (t, ops) => ops.eq(t.id, invoiceId)))
        .run();
      audit({
        entity: "invoice",
        entityId: invoiceId,
        ownerId: userId,
        scope: "user",
        before: { [field]: before[field] },
        after: { [field]: value },
      });
    }),
  );
}

export function snoozeReminders(actor: Actor, invoiceId: string, until: CalendarDate | null): void {
  const today = calendarDateInPrague(clock.now());
  const inRange =
    until === null ||
    (isCalendarDate(until) && until >= today && until <= addDays(today, MAX_SNOOZE_DAYS));
  if (!inRange) {
    throw new ServiceError(E.snoozeRange);
  }
  changeInvoice(actor, invoiceId, "invoice.reminders_snooze", "remindersSnoozeUntil", until);
}

export function setRemindersOff(actor: Actor, invoiceId: string, off: boolean): void {
  changeInvoice(actor, invoiceId, "invoice.reminders_off", "remindersOff", off);
}

export function setPartialReminders(actor: Actor, invoiceId: string, on: boolean): void {
  changeInvoice(actor, invoiceId, "invoice.reminders_partial", "remindersPartial", on);
}

export function reminderHistory(ownerId: string, invoiceId: string) {
  return db
    .select({
      id: reminderSent.id,
      stageKey: reminderSent.stageKey,
      trigger: reminderSent.trigger,
      createdAt: reminderSent.createdAt,
    })
    .from(reminderSent)
    .where(scoped(ownerId).where(reminderSent, (t, ops) => ops.eq(t.invoiceId, invoiceId)))
    .orderBy(reminderSent.createdAt)
    .all();
}

function reminderCandidates(q: Reader, ownerId: string, invoiceId?: string) {
  return q
    .select(REMINDER_COLUMNS)
    .from(invoice)
    .leftJoin(customer, eq(customer.id, invoice.customerId))
    .where(
      scoped(ownerId).where(invoice, (t, ops) =>
        ops.and(
          inArray(t.status, ["sent", "partially_paid"]),
          isNotNull(t.dueDate),
          invoiceId ? ops.eq(t.id, invoiceId) : undefined,
        ),
      ),
    )
    .all()
    .filter((row) => isEligibleForReminder(row, { remindersEnabled: row.remindersEnabled }));
}

type Candidate = ReturnType<typeof reminderCandidates>[number];

function sentByInvoice(q: Reader, ownerId: string): Map<string, string[]> {
  const stages = new Map<string, string[]>();
  const rows = q
    .select({ invoiceId: reminderSent.invoiceId, stageKey: reminderSent.stageKey })
    .from(reminderSent)
    .where(scoped(ownerId).where(reminderSent))
    .all();
  for (const { invoiceId, stageKey } of rows) {
    stages.set(invoiceId, [...(stages.get(invoiceId) ?? []), stageKey]);
  }
  return stages;
}

export type ReviewRow = {
  invoiceId: string;
  number: string | null;
  customerName: string;
  dueDate: CalendarDate;
  stageKey: string;
  offsetDays: number;
  stageDate: CalendarDate;
  amountDueMinor: number;
  currency: Candidate["currency"];
};

export function remindersForReview(ownerId: string, today: CalendarDate): ReviewRow[] {
  const { reminders, remindersOpenSince: openSince } = getAutomation(ownerId);
  if (!reminders || !openSince) return [];
  const rules = listReminderRules(ownerId);
  if (rules.length === 0) return [];
  const sent = sentByInvoice(db, ownerId);
  return reminderCandidates(db, ownerId).flatMap((row) => {
    const sentStages = sent.get(row.id) ?? [];
    const rule = stageForReview({ invoice: row, rules, sentStages, today, openSince });
    if (!rule || !row.dueDate) return [];
    return {
      invoiceId: row.id,
      number: row.number,
      customerName: row.customerName,
      dueDate: row.dueDate,
      stageKey: rule.id,
      offsetDays: rule.offsetDays,
      stageDate: stageDate({ ...row, dueDate: row.dueDate }, rule.offsetDays),
      amountDueMinor: amountDue(row),
      currency: row.currency,
    };
  });
}

const blockedPrefix = (invoiceId: string, stageKey: string) =>
  `reminder:blocked:${invoiceId}:${stageKey}:`;

function alreadyBlocked(ownerId: string, dedupeKey: string): boolean {
  const row = db
    .select({ id: notification.id })
    .from(notification)
    .where(scoped(ownerId).where(notification, (t, ops) => ops.eq(t.dedupeKey, dedupeKey)))
    .get();
  return row !== undefined;
}

function resolveBlocked(tx: Tx, ownerId: string, invoiceId: string, stageKey: string): void {
  tx.update(notification)
    .set({ resolvedAt: clock.now() })
    .where(
      scoped(ownerId).where(notification, (t) =>
        and(
          like(t.dedupeKey, `${blockedPrefix(invoiceId, stageKey)}%`),
          sql`${t.resolvedAt} IS NULL`,
        ),
      ),
    )
    .run();
}

function buildMessage(ownerId: string, invoiceId: string, rule: ReminderRule) {
  let draft;
  try {
    draft = composeMail(ownerId, invoiceId, "reminder", undefined, rule.texts);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { problems: error.message };
  }
  if (draft.to.length === 0) return { problems: E.noAddress };
  const parsed = mailMessageSchema.safeParse(draft);
  if (!parsed.success) {
    return { problems: parsed.error.issues[0]?.message ?? TEXTS.invoiceMail.errors.invalid };
  }
  const { to, cc, bcc, subject, body } = parsed.data;
  return { message: { to, cc, bcc, subject, body } };
}

type Fresh = { row: Candidate; rule: ReminderRule; date: CalendarDate };

// Everything is judged again in the transaction: the snapshot the tick read may be minutes old.
function freshStage(tx: Tx, ownerId: string, invoiceId: string, today: CalendarDate): Fresh | null {
  const { remindersOpenSince: openSince } = getAutomation(ownerId);
  if (!openSince || !automaticSendAllowed(ownerId, "reminders")) return null;
  const row = reminderCandidates(tx, ownerId, invoiceId)[0];
  if (!row?.dueDate) return null;
  const rule = dueStage({
    invoice: row,
    rules: listReminderRules(ownerId, tx),
    sentStages: sentStagesOf(tx, ownerId, invoiceId),
    today,
    openSince,
  });
  if (!rule) return null;
  return { row, rule, date: stageDate({ ...row, dueDate: row.dueDate }, rule.offsetDays) };
}

function recordBlocked(
  tx: Tx,
  audit: Audit,
  ownerId: string,
  { row, rule }: Fresh,
  dedupeKey: string,
  problems: string,
): void {
  notify(tx, {
    userId: ownerId,
    kind: "reminder_failed",
    dedupeKey,
    params: { invoice: row.number, problems },
    entity: { type: "invoice", id: row.id },
  });
  audit({
    action: "reminder.blocked",
    entity: "invoice",
    entityId: row.id,
    ownerId,
    scope: "user",
    after: { stageKey: rule.id },
  });
}

function sendStage(ownerId: string, invoiceId: string, seen: string, today: CalendarDate): void {
  // Carries the date, so a stage still blocked tomorrow is a new event rather than a lost one.
  const dedupeKey = `${blockedPrefix(invoiceId, seen)}${today}`;
  if (alreadyBlocked(ownerId, dedupeKey)) return;
  unlessUnchanged(() =>
    mutate(schedulerActor(ownerId), "reminder.send", (tx, audit) => {
      const fresh = freshStage(tx, ownerId, invoiceId, today);
      if (fresh?.rule.id !== seen) throw new Unchanged(undefined);
      const { rule, date } = fresh;
      const built = buildMessage(ownerId, invoiceId, rule);
      if (!built.message) {
        recordBlocked(tx, audit, ownerId, fresh, dedupeKey, built.problems);
        return;
      }
      const queued = queueMail(tx, audit, {
        userId: ownerId,
        invoiceId,
        kind: "reminder",
        trigger: "automatic",
        automation: "reminders",
        plannedFor: date,
        key: `reminder:${invoiceId}:${rule.id}`,
        message: built.message,
      });
      // Either way the stage stays unspent, and a conflict must take the queued message back.
      if (!queued) throw new Unchanged(undefined);
      if (!insertSent(tx, ownerId, invoiceId, rule.id, "automatic", queued.logId)) {
        throw new Unchanged(undefined);
      }
      resolveBlocked(tx, ownerId, invoiceId, rule.id);
      audit({
        entity: "invoice",
        entityId: invoiceId,
        ownerId,
        scope: "user",
        after: { stageKey: rule.id, logId: queued.logId, plannedFor: date },
      });
    }),
  );
}

function remindingAccounts() {
  return db
    .select({
      userId: automationSettings.userId,
      sendTime: automationSettings.sendTime,
      openSince: automationSettings.remindersOpenSince,
    })
    .from(automationSettings)
    .innerJoin(user, eq(user.id, automationSettings.userId))
    .where(
      and(
        eq(automationSettings.reminders, true),
        eq(automationSettings.paused, false),
        isNotNull(automationSettings.remindersOpenSince),
        sql`coalesce(${user.banned}, 0) = 0`,
      ),
    )
    .all();
}

function planAccount(ownerId: string, openSince: CalendarDate, today: CalendarDate): void {
  const rules = listReminderRules(ownerId);
  if (rules.length === 0) return;
  const sent = sentByInvoice(db, ownerId);
  for (const row of reminderCandidates(db, ownerId)) {
    const sentStages = sent.get(row.id) ?? [];
    const rule = dueStage({ invoice: row, rules, sentStages, today, openSince });
    if (rule) sendStage(ownerId, row.id, rule.id, today);
  }
}

export function planReminders(now: Date): void {
  const today = calendarDateInPrague(now);
  for (const { userId, sendTime, openSince } of remindingAccounts()) {
    if (!openSince || !isDailyDue(now, sendTime)) continue;
    try {
      planAccount(userId, openSince, today);
    } catch (error) {
      reportFailure(error, { task: "reminder-plan", userId });
    }
  }
}
