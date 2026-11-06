import "server-only";
import { fitText } from "@/lib/text-limits";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { kindForInvoice } from "@/lib/email-template";
import { mailMessageSchema } from "@/lib/mail-send";
import { rateDate } from "@/lib/fx";
import { addDays, daysBetween } from "@/lib/invoice";
import { calendarDateInPrague, isDailyDue, type CalendarDate } from "@/lib/number-format";
import {
  nextOccurrences,
  occurrencesBetween,
  type Occurrence,
  type RecurrenceRule,
  type RunStatus,
} from "@/lib/recurrence";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import {
  automationSettings,
  job,
  notification,
  recurringInvoice,
  recurringRun,
  user,
  type Job,
  type RecurringInvoice,
} from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue, removeDeadJob, takeIdleJobs } from "../jobs/queue";
import { RetryLater } from "../jobs/registry";
import { reportFailure } from "../scheduler/report";
import { ServiceError, type Reader } from "./access";
import { automaticSendAllowed, getAutomation } from "./automation";
import { composeMail } from "./email-templates";
import { ensureRate } from "./exchange-rates";
import { issueIn } from "./invoice-lifecycle";
import { queueMail } from "./invoice-mail";
import { draftInputFromDocument } from "./invoice-templates";
import { noticeIssuedRate } from "./rate-notice";
import {
  createDraftIn,
  findOwned,
  ownerOf,
  parseDraft,
  unlessUnchanged,
  Unchanged,
  type SavedDraft,
} from "./invoices";
import { resolveTransport } from "./mail-settings";
import { mutate, type Audit } from "./mutation";
import { notify, resolveNotification } from "./notifications";
import { ensureDefaultSeries } from "./number-series";
import { getPreferences } from "./preferences";
import {
  findPlan,
  planHeadColumns,
  readPlan,
  ruleOf,
  runKeyPrefix,
  sameBilledPeriod,
  type PlanHead,
} from "./recurring";

const V = TEXTS.recurring.validation;
const R = TEXTS.recurring.reasons;

const MAX_CATCH_UP_DAYS = 3;
const MAX_REASON_CHARS = 200;
const NOTICE_RETRY_MS = 30 * 60_000;

export type RunOccurrence = Pick<Occurrence, "periodKey" | "issueDate" | "billedPeriod">;

export type RunResult = {
  runId: string;
  status: RunStatus;
  invoiceId: string | null;
} | null;

const schedulerActor = (userId: string): Actor => ({ userId, source: "scheduler" });

const runKey = (planId: string, periodKey: string) => `${runKeyPrefix(planId)}${periodKey}`;

function occurrencePayload({ periodKey, issueDate, billedPeriod }: RunOccurrence) {
  return { periodKey, issueDate, periodFrom: billedPeriod.from, periodTo: billedPeriod.to };
}

function occurrenceOf(row: Job): RunOccurrence {
  const { periodKey, issueDate, periodFrom, periodTo } = row.payload;
  return {
    periodKey: String(periodKey),
    issueDate: String(issueDate),
    billedPeriod: { from: String(periodFrom), to: String(periodTo) },
  };
}

function insertRun(
  tx: Tx,
  plan: PlanHead,
  occurrence: RunOccurrence,
  status: RunStatus,
  reason: string | null = null,
): string | null {
  const row = tx
    .insert(recurringRun)
    .values({
      id: randomUUID(),
      userId: plan.userId,
      recurringId: plan.id,
      periodKey: occurrence.periodKey,
      plannedDate: occurrence.issueDate,
      periodFrom: occurrence.billedPeriod.from,
      periodTo: occurrence.billedPeriod.to,
      status,
      reason: reason === null ? null : fitText("recurring_run", "reason", reason),
      createdAt: clock.now(),
    })
    .onConflictDoNothing()
    .returning({ id: recurringRun.id })
    .get();
  return row?.id ?? null;
}

function updateRun(
  tx: Tx,
  userId: string,
  runId: string,
  fields: { status: RunStatus; invoiceId?: string | null; reason?: string | null },
): void {
  tx.update(recurringRun)
    .set(fields)
    .where(scoped(userId).where(recurringRun, (t, { eq }) => eq(t.id, runId)))
    .run();
}

function displayDate(ownerId: string, date: CalendarDate): string {
  return formatCalendarDate(date, getPreferences(ownerId).dateFormat);
}

// One notice per plan however many occurrences it covers.
function noticeMissed(tx: Tx, plan: PlanHead, recorded: RunOccurrence[]): void {
  const last = recorded.at(-1);
  if (!last) return;
  notify(tx, {
    userId: plan.userId,
    kind: "recurring_missed",
    dedupeKey: `recurring:missed:${plan.id}:${last.periodKey}`,
    params: {
      plan: plan.name,
      date: displayDate(plan.userId, last.issueDate),
      count: recorded.length,
    },
    entity: { type: "recurring_invoice", id: plan.id },
  });
}

// A plan edited under a queued job can bill another period under a key that already has a run.
// The unique index would drop that occurrence, so somebody has to be told about it.
function noticeConflict(tx: Tx, plan: PlanHead, occurrence: RunOccurrence): boolean {
  const { periodKey, issueDate, billedPeriod } = occurrence;
  const taken = tx
    .select()
    .from(recurringRun)
    .where(
      scoped(plan.userId).where(recurringRun, (t, { and, eq }) =>
        and(eq(t.recurringId, plan.id), eq(t.periodKey, periodKey)),
      ),
    )
    .get();
  const planned = { periodFrom: billedPeriod.from, periodTo: billedPeriod.to };
  if (!taken || sameBilledPeriod(taken, planned)) return false;
  notify(tx, {
    userId: plan.userId,
    kind: "recurring_conflict",
    dedupeKey: `recurring:conflict:${plan.id}:${periodKey}:${billedPeriod.from}:${billedPeriod.to}`,
    params: { plan: plan.name, date: displayDate(plan.userId, issueDate) },
    entity: { type: "recurring_invoice", id: plan.id },
  });
  return true;
}

function recordMissed(
  tx: Tx,
  plan: PlanHead,
  occurrences: RunOccurrence[],
  reason: string,
): number {
  const recorded = occurrences.filter((item) => {
    const inserted = insertRun(tx, plan, item, "missed", reason);
    if (!inserted) noticeConflict(tx, plan, item);
    return inserted;
  });
  noticeMissed(tx, plan, recorded);
  return recorded.length;
}

function moveCursor(tx: Tx, plan: PlanHead, rule: RecurrenceRule, cursorDate: CalendarDate): void {
  const finished = nextOccurrences(rule, cursorDate, 1).length === 0;
  // A finished plan goes back to work when its last occurrence has to be planned again.
  const status = finished ? "finished" : plan.status === "finished" ? "active" : plan.status;
  tx.update(recurringInvoice)
    .set({ cursorDate, status, updatedAt: clock.now() })
    .where(scoped(plan.userId).where(recurringInvoice, (t, { eq }) => eq(t.id, plan.id)))
    .run();
}

// A finished plan may still have its last occurrence waiting in a job that deactivation cancelled.
// Without the document: markMissed needs only the rule, and a plan's document is read where a run
// builds its invoice, one plan at a time (I-3 of plan 9).
export function reviewablePlansOf(q: Reader, ownerId: string): PlanHead[] {
  return q
    .select(planHeadColumns)
    .from(recurringInvoice)
    .where(
      scoped(ownerId).where(recurringInvoice, (t) => inArray(t.status, ["active", "finished"])),
    )
    .all();
}

// After a pause or deactivation nothing old may run by itself (REC-005, ADM-005). Jobs that never
// started are taken back too: they would run the old occurrence, or block today's under their key.
export function markMissed(tx: Tx, audit: Audit, plan: PlanHead, today: CalendarDate) {
  // Before the jobs go: the limit counts them, and they only become runs further down.
  const rule = ruleOf(tx, plan);
  const idle = takeIdleJobs(tx, plan.userId, runKeyPrefix(plan.id)).map(occurrenceOf);
  if (plan.status === "finished" && idle.length === 0) return;
  const yesterday = addDays(today, -1);
  const past = [...idle, ...occurrencesBetween(rule, plan.cursorDate, yesterday)].filter(
    (item) => item.issueDate <= yesterday,
  );
  const missed = recordMissed(tx, plan, past, R.paused);
  moveCursor(tx, plan, rule, yesterday);
  audit({
    action: "recurring.plan",
    entity: "recurring_invoice",
    entityId: plan.id,
    ownerId: plan.userId,
    scope: "user",
    before: { cursorDate: plan.cursorDate },
    after: { cursorDate: yesterday, missed },
  });
}

export function pauseRecurring(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "recurring.pause", (tx, audit) => {
    const plan = findPlan(tx, userId, id);
    if (plan.status !== "active") throw new ServiceError(V.notActive);
    tx.update(recurringInvoice)
      .set({ status: "paused", updatedAt: clock.now() })
      .where(scoped(userId).where(recurringInvoice, (t, { eq }) => eq(t.id, id)))
      .run();
    audit({
      entity: "recurring_invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { status: plan.status },
      after: { status: "paused" },
    });
  });
}

export function resumeRecurring(actor: Actor, id: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "recurring.resume", (tx, audit) => {
    const plan = findPlan(tx, userId, id);
    if (plan.status === "finished") {
      if (nextOccurrences(ruleOf(tx, plan), plan.cursorDate, 1).length === 0) {
        throw new ServiceError(V.nothingLeft);
      }
    } else if (plan.status !== "paused") {
      throw new ServiceError(V.notPaused);
    }
    tx.update(recurringInvoice)
      .set({ status: "active", updatedAt: clock.now() })
      .where(scoped(userId).where(recurringInvoice, (t, { eq }) => eq(t.id, id)))
      .run();
    markMissed(tx, audit, { ...plan, status: "active" }, calendarDateInPrague(clock.now()));
    audit({
      entity: "recurring_invoice",
      entityId: id,
      ownerId: userId,
      scope: "user",
      before: { status: plan.status },
      after: { status: "active" },
    });
  });
}

function plannablePlans(where?: ReturnType<typeof sql>) {
  return db
    .select({ plan: planHeadColumns, sendTime: automationSettings.sendTime })
    .from(recurringInvoice)
    .innerJoin(user, eq(user.id, recurringInvoice.userId))
    .leftJoin(automationSettings, eq(automationSettings.userId, recurringInvoice.userId))
    .where(and(eq(recurringInvoice.status, "active"), sql`coalesce(${user.banned}, 0) = 0`, where))
    .all();
}

// A missing settings row means the default time.
function sendTimeOf(ownerId: string, sendTime: string | null): string {
  return sendTime ?? getAutomation(ownerId).sendTime;
}

function planWork(q: Reader, plan: PlanHead, through: CalendarDate) {
  const rule = ruleOf(q, plan);
  const due = occurrencesBetween(rule, plan.cursorDate, through);
  const cursorDate = through > plan.cursorDate ? through : plan.cursorDate;
  const finished = nextOccurrences(rule, cursorDate, 1).length === 0;
  return { rule, due, cursorDate, idle: due.length === 0 && !finished };
}

function planOne(seen: PlanHead, through: CalendarDate, today: CalendarDate): void {
  if (planWork(db, seen, through).idle) return;
  unlessUnchanged(() =>
    mutate(schedulerActor(seen.userId), "recurring.plan", (tx, audit) => {
      const plan = readPlan(tx, seen.userId, seen.id);
      if (plan?.status !== "active") throw new Unchanged(undefined);
      const { rule, due, cursorDate, idle } = planWork(tx, plan, through);
      if (idle) throw new Unchanged(undefined);
      const fresh = due.filter((item) => daysBetween(item.issueDate, today) <= MAX_CATCH_UP_DAYS);
      const stale = due.filter((item) => !fresh.includes(item));
      for (const occurrence of fresh) {
        enqueue(tx, {
          kind: "recurring.run",
          key: runKey(plan.id, occurrence.periodKey),
          userId: plan.userId,
          payload: { recurringId: plan.id, ...occurrencePayload(occurrence) },
        });
      }
      const missed = recordMissed(tx, plan, stale, R.tooOld);
      moveCursor(tx, plan, rule, cursorDate);
      audit({
        entity: "recurring_invoice",
        entityId: plan.id,
        ownerId: plan.userId,
        scope: "user",
        before: { cursorDate: plan.cursorDate },
        after: { cursorDate, planned: fresh.length, missed },
      });
    }),
  );
}

export function planRecurringRuns(now: Date): void {
  const today = calendarDateInPrague(now);
  for (const { plan, sendTime } of plannablePlans()) {
    const due = isDailyDue(now, sendTimeOf(plan.userId, sendTime));
    try {
      planOne(plan, due ? today : addDays(today, -1), today);
    } catch (error) {
      reportFailure(error, { task: "recurring-plan", userId: plan.userId });
    }
  }
}

// A dead job has no further run or recovery, and its cursor has moved on, so only this can keep the
// occurrence from disappearing. Removing the job frees its key for a later date in the same period.
export function settleDeadRuns(): void {
  const stranded = db
    .select({ row: job, plan: recurringInvoice })
    .from(job)
    .innerJoin(
      recurringInvoice,
      sql`${recurringInvoice.id} = json_extract(${job.payload}, '$.recurringId')`,
    )
    .where(and(eq(job.status, "dead"), eq(job.kind, "recurring.run")))
    .all();
  for (const { row, plan } of stranded) {
    try {
      unlessUnchanged(() =>
        mutate(schedulerActor(plan.userId), "recurring.run", (tx, audit) => {
          if (!removeDeadJob(tx, plan.userId, row.id)) throw new Unchanged(undefined);
          const missed = recordMissed(tx, plan, [occurrenceOf(row)], R.failed);
          audit({
            entity: "recurring_invoice",
            entityId: plan.id,
            ownerId: plan.userId,
            scope: "user",
            after: { periodKey: row.payload.periodKey, missed },
          });
        }),
      );
    } catch (error) {
      reportFailure(error, { task: "dead-recurring", userId: plan.userId });
    }
  }
}

function draftFor(
  tx: Tx,
  audit: Audit,
  plan: RecurringInvoice,
  occurrence: RunOccurrence,
): SavedDraft {
  const input = draftInputFromDocument(plan.userId, plan.document, plan.customerId, {
    issueDate: occurrence.issueDate,
  });
  return createDraftIn(
    tx,
    audit,
    plan.userId,
    parseDraft(input),
    {
      recurringId: plan.id,
      periodFrom: occurrence.billedPeriod.from,
      periodTo: occurrence.billedPeriod.to,
    },
    { fromRecurring: { id: plan.id, name: plan.name } },
  );
}

// The account-wide switch stops issuing as well as sending; recurringSend only concerns sending (R-6).
function effectiveMode(plan: PlanHead): PlanHead["mode"] {
  if (plan.mode === "draft") return "draft";
  if (getAutomation(plan.userId).paused) return "draft";
  if (plan.mode === "issue") return "issue";
  return plan.sendConfirmedAt && automaticSendAllowed(plan.userId, "recurringSend")
    ? "send"
    : "draft";
}

type DraftAttempt = { draft: SavedDraft } | { problems: string };

function draftSafely(
  tx: Tx,
  audit: Audit,
  plan: RecurringInvoice,
  occurrence: RunOccurrence,
): DraftAttempt {
  try {
    return { draft: tx.transaction((savepoint) => draftFor(savepoint, audit, plan, occurrence)) };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { problems: error.message };
  }
}

function issueSafely(
  tx: Tx,
  audit: Audit,
  userId: string,
  draft: SavedDraft,
): { issued: true; number: string } | { issued: false; problems: string } {
  try {
    const { number } = tx.transaction((savepoint) =>
      issueIn(savepoint, audit, userId, draft.id, { revision: draft.revision }),
    );
    return { issued: true, number };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { issued: false, problems: error.message };
  }
}

type MailOutcome = { queued: boolean } | { problems: string };

function queueRecurringMail(
  tx: Tx,
  audit: Audit,
  plan: RecurringInvoice,
  occurrence: RunOccurrence,
  runId: string,
  invoiceId: string,
): MailOutcome {
  const { userId } = plan;
  const kind = kindForInvoice(findOwned(tx, userId, invoiceId).type);
  const draft = composeMail(userId, invoiceId, kind);
  if (draft.to.length === 0) return { queued: false };
  const message = mailMessageSchema.safeParse(draft);
  if (!message.success) {
    return { problems: message.error.issues[0]?.message ?? TEXTS.invoiceMail.errors.invalid };
  }
  const { to, cc, bcc, subject, body } = message.data;
  const queued = queueMail(tx, audit, {
    userId,
    invoiceId,
    kind,
    trigger: "automatic",
    automation: "recurringSend",
    plannedFor: occurrence.issueDate,
    key: `mail:recurring:${runId}`,
    message: { to, cc, bcc, subject, body },
  });
  return { queued: queued !== null };
}

function createInvoice(
  tx: Tx,
  audit: Audit,
  plan: RecurringInvoice,
  occurrence: RunOccurrence,
  runId: string,
): { status: RunStatus; invoiceId: string | null; reason?: string } {
  const { userId } = plan;
  const attempt = draftSafely(tx, audit, plan, occurrence);
  if ("problems" in attempt) {
    noticeMissed(tx, plan, [occurrence]);
    const reason = attempt.problems.slice(0, MAX_REASON_CHARS);
    return { status: "missed", invoiceId: null, reason };
  }
  const { draft } = attempt;
  const invoiceId = draft.id;
  const params = { plan: plan.name };
  const dedupeKey = `recurring:${runId}`;
  const entity = { type: "invoice", id: invoiceId };

  const mode = effectiveMode(plan);
  if (mode === "draft") {
    if (plan.mode === "draft") return { status: "created", invoiceId };
    notify(tx, { userId, kind: "recurring_held", dedupeKey, params, entity });
    return { status: "fallback", invoiceId, reason: R.held };
  }

  const result = issueSafely(tx, audit, userId, draft);
  if (!result.issued) {
    const { problems } = result;
    const notice = { ...params, problems };
    notify(tx, { userId, kind: "recurring_failed", dedupeKey, params: notice, entity });
    return { status: "fallback", invoiceId, reason: problems.slice(0, MAX_REASON_CHARS) };
  }
  noticeIssuedRate(tx, userId, invoiceId, dedupeKey, params);
  if (mode === "issue") return { status: "issued", invoiceId };

  const invoice = result.number;
  const outcome = queueRecurringMail(tx, audit, plan, occurrence, runId, invoiceId);
  if ("problems" in outcome) {
    const { problems } = outcome;
    const notice = { ...params, invoice, problems };
    notify(tx, { userId, kind: "recurring_bad_mail", dedupeKey, params: notice, entity });
    return { status: "issued", invoiceId, reason: problems.slice(0, MAX_REASON_CHARS) };
  }
  if (outcome.queued) return { status: "queued", invoiceId };
  const notice = { ...params, invoice };
  notify(tx, { userId, kind: "recurring_no_address", dedupeKey, params: notice, entity });
  return { status: "issued", invoiceId, reason: R.noAddress };
}

// The unique index on (plan, period) decides here, not a lease: only one run ever inserts the row.
export function processOccurrence(
  ownerId: string,
  recurringId: string,
  occurrence: RunOccurrence,
): RunResult {
  const actor = schedulerActor(ownerId);
  const seen = readPlan(db, ownerId, recurringId);
  if (seen && effectiveMode(seen) !== "draft") ensureDefaultSeries(actor);
  return unlessUnchanged(() =>
    mutate(actor, "recurring.run", (tx, audit) => {
      const plan = readPlan(tx, ownerId, recurringId);
      if (!plan) throw new Unchanged<RunResult>(null);
      const today = calendarDateInPrague(clock.now());
      const tooOld = daysBetween(occurrence.issueDate, today) > MAX_CATCH_UP_DAYS;

      if (noticeConflict(tx, plan, occurrence)) {
        audit({
          entity: "recurring_invoice",
          entityId: plan.id,
          ownerId,
          scope: "user",
          after: { ...occurrencePayload(occurrence), conflict: true },
        });
        return null;
      }

      let result: NonNullable<RunResult>;
      if (plan.status === "paused" || tooOld) {
        const missed = recordMissed(tx, plan, [occurrence], tooOld ? R.tooOld : R.paused);
        if (missed === 0) throw new Unchanged<RunResult>(null);
        const row = tx
          .select({ id: recurringRun.id })
          .from(recurringRun)
          .where(
            scoped(ownerId).where(recurringRun, (t, { and, eq }) =>
              and(eq(t.recurringId, plan.id), eq(t.periodKey, occurrence.periodKey)),
            ),
          )
          .get();
        result = { runId: row!.id, status: "missed", invoiceId: null };
      } else {
        const runId = insertRun(tx, plan, occurrence, "created");
        if (!runId) throw new Unchanged<RunResult>(null);
        const { status, invoiceId, reason } = createInvoice(tx, audit, plan, occurrence, runId);
        updateRun(tx, ownerId, runId, { status, invoiceId, reason: reason ?? null });
        result = { runId, status, invoiceId };
      }
      audit({
        entity: "recurring_invoice",
        entityId: plan.id,
        ownerId,
        scope: "user",
        after: { ...occurrencePayload(occurrence), ...result },
      });
      return result;
    }),
  );
}

// The network runs here, before the transaction: an outage leaves the last known rate, and the
// occurrence is issued or falls back to a draft as it would without a rate (R-11).
async function warmRate(ownerId: string, recurringId: string, occurrence: RunOccurrence) {
  const currency = readPlan(db, ownerId, recurringId)?.document.currency;
  if (!currency || currency === "CZK") return;
  const { issueDate } = occurrence;
  await ensureRate(
    currency,
    rateDate({ issueDate, taxableDate: null }, getPreferences(ownerId).fxBasis, issueDate),
  );
}

export async function runRecurringJob(row: Job): Promise<void> {
  if (!row.userId) throw new Error("Úloha pravidelné faktury nemá vlastníka");
  const recurringId = String(row.payload.recurringId);
  const occurrence = occurrenceOf(row);
  await warmRate(row.userId, recurringId, occurrence);
  processOccurrence(row.userId, recurringId, occurrence);
}

function resolveMissedNotices(tx: Tx, userId: string, planId: string): void {
  const left = tx
    .select({ n: count() })
    .from(recurringRun)
    .where(
      scoped(userId).where(recurringRun, (t, { and, eq }) =>
        and(eq(t.recurringId, planId), eq(t.status, "missed")),
      ),
    )
    .get();
  if (left?.n) return;
  const notices = tx
    .select({ dedupeKey: notification.dedupeKey })
    .from(notification)
    .where(
      scoped(userId).where(notification, (t, { and, eq }) =>
        and(eq(t.kind, "recurring_missed"), eq(t.entityId, planId)),
      ),
    )
    .all();
  for (const { dedupeKey } of notices) resolveNotification(tx, userId, dedupeKey);
}

// A person decided here, so the result is always a draft: a missed occurrence never sends (R-19).
export function resolveMissed(
  actor: Actor,
  runId: string,
  action: "draft" | "skip",
): { invoiceId: string | null } {
  const userId = ownerOf(actor);
  const auditAction = action === "draft" ? "recurring.missed_draft" : "recurring.missed_skip";
  return mutate(actor, auditAction, (tx, audit) => {
    const run = tx
      .select()
      .from(recurringRun)
      .where(scoped(userId).where(recurringRun, (t, { eq }) => eq(t.id, runId)))
      .get();
    if (run?.status !== "missed") throw new ServiceError(V.notMissed);
    const plan = findPlan(tx, userId, run.recurringId);

    let invoiceId: string | null = null;
    if (action === "draft") {
      invoiceId = draftFor(tx, audit, plan, {
        periodKey: run.periodKey,
        issueDate: run.plannedDate,
        billedPeriod: { from: run.periodFrom, to: run.periodTo },
      }).id;
      updateRun(tx, userId, runId, { status: "created", invoiceId, reason: null });
    } else {
      updateRun(tx, userId, runId, { status: "skipped" });
    }
    resolveMissedNotices(tx, userId, plan.id);
    audit({
      entity: "recurring_invoice",
      entityId: plan.id,
      ownerId: userId,
      scope: "user",
      before: { runId, status: "missed" },
      after: { runId, action, invoiceId },
    });
    return { invoiceId };
  });
}

function noticePlan(plan: PlanHead, occurrence: Occurrence): void {
  const key = `notice:${plan.id}:${occurrence.periodKey}`;
  const { userId } = plan;
  unlessUnchanged(() =>
    mutate(schedulerActor(userId), "recurring.notice", (tx, audit) => {
      const queued = enqueue(tx, {
        kind: "user.notice",
        key,
        userId,
        payload: { recurringId: plan.id, issueDate: occurrence.issueDate },
      });
      if (!queued.created) throw new Unchanged(undefined);
      notify(tx, {
        userId,
        kind: "recurring_upcoming",
        dedupeKey: key,
        params: {
          plan: plan.name,
          date: displayDate(userId, occurrence.issueDate),
          sends: effectiveMode(plan) === "send",
        },
        entity: { type: "recurring_invoice", id: plan.id },
      });
      audit({
        entity: "recurring_invoice",
        entityId: plan.id,
        ownerId: userId,
        scope: "user",
        after: { issueDate: occurrence.issueDate },
      });
    }),
  );
}

// Runs under the master switch as well: a message to the account owner leaves nothing to a client (R-27).
export function planRecurringNotices(now: Date): void {
  const today = calendarDateInPrague(now);
  const candidates = plannablePlans(
    sql`${recurringInvoice.mode} = 'send' AND ${isNotNull(recurringInvoice.notifyDaysBefore)}`,
  );
  for (const { plan, sendTime } of candidates) {
    if (!isDailyDue(now, sendTimeOf(plan.userId, sendTime))) continue;
    const after = plan.cursorDate > today ? plan.cursorDate : today;
    const through = addDays(today, plan.notifyDaysBefore!);
    try {
      for (const item of occurrencesBetween(ruleOf(db, plan), after, through))
        noticePlan(plan, item);
    } catch (error) {
      reportFailure(error, { task: "recurring-notice", userId: plan.userId });
    }
  }
}

export async function deliverUserNotice(row: Job): Promise<void> {
  if (!row.userId) throw new Error("Upozornění uživatele nemá vlastníka");
  const plan = readPlan(db, row.userId, String(row.payload.recurringId));
  const account = db.select({ email: user.email }).from(user).where(eq(user.id, row.userId)).get();
  if (!plan || !account) return;
  const transport = await resolveTransport(row.userId);
  if (!transport) return;
  const { from, replyTo } = transport.identity;
  const { subject, body } = TEXTS.recurring.upcomingMail;
  const date = displayDate(row.userId, String(row.payload.issueDate));
  try {
    // Without the account's standing copies: this message is for the owner alone.
    await transport.send({
      from,
      ...(replyTo ? { replyTo } : {}),
      to: account.email,
      subject,
      text: body(plan.name, date, effectiveMode(plan) === "send"),
    });
  } catch {
    throw new RetryLater("Upozornění se zopakuje", NOTICE_RETRY_MS);
  }
}
