import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NotificationKind } from "@/lib/automation";
import { kindForInvoice } from "@/lib/email-template";
import { daysBetween } from "@/lib/invoice";
import { isSendable } from "@/lib/mail-send";
import { calendarDateInPrague } from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import { isEligibleForReminder } from "@/lib/reminders";
import { classifySmtpError, smtpFailureText } from "@/lib/smtp-errors";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { emailLog, job, user, type EmailLog, type Job } from "../db/schema";
import { scoped } from "../db/scoped";
import { completeJob, retryJob } from "../jobs/queue";
import { RetryLater } from "../jobs/registry";
import type { MailAddress, MailMessage, MailTransport, SendResult } from "../mail/transport";
import { reportFailure } from "../scheduler/report";
import { automaticSendAllowed } from "./automation";
import { getCustomer } from "./customers";
import { archiveSentPdf, readOwnedFile } from "./files";
import { applySent } from "./invoice-lifecycle";
import { invoicePdf } from "./invoice-pdf";
import { mailNoticeKey as noticeKey } from "./invoice-mail";
import { getInvoice, type InvoiceDetail } from "./invoices";
import { resolveTransport } from "./mail-settings";
import { mutate } from "./mutation";
import { resolveNotification, notify } from "./notifications";

const R = TEXTS.invoiceMail.reasons;

// The sum stays under the 120 s lease, so recovery can never touch an attempt still running. The
// PDF share also covers waiting in the render queue, on top of the renderer's own 30 s.
export const DELIVERY_LIMITS = { pdfMs: 40_000, smtpMs: 70_000 };

const MAX_REASON_CHARS = 200;
const MAX_AUTOMATIC_DELAY_DAYS = 3;
const MINUTE = 60_000;
const RETRY_DELAYS_MS = [5 * MINUTE, 30 * MINUTE, 120 * MINUTE];

let limits = DELIVERY_LIMITS;

export function setDeliveryLimitsForTests(over: Partial<typeof DELIVERY_LIMITS> | null): void {
  limits = { ...DELIVERY_LIMITS, ...over };
}

class DeadlineError extends Error {}

function withDeadline<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("Pokus překročil časový strop")), ms);
  });
  return Promise.race([new Promise<T>((resolve) => resolve(work())), expired]).finally(() =>
    clearTimeout(timer),
  );
}

const actorOf = (log: EmailLog): Actor => ({ userId: log.userId, source: "scheduler" });

function readLog(row: Job): EmailLog | undefined {
  if (!row.userId) throw new Error("Úloha odeslání nemá vlastníka");
  const logId = String(row.payload.logId);
  return db
    .select()
    .from(emailLog)
    .where(scoped(row.userId).where(emailLog, (t, { eq: is }) => is(t.id, logId)))
    .get();
}

function isDeactivated(userId: string): boolean {
  const row = db.select({ banned: user.banned }).from(user).where(eq(user.id, userId)).get();
  return !row || Boolean(row.banned);
}

const exhausted = (row: Job) => row.attempts >= row.maxAttempts;

// False once recovery has taken the job over: a late attempt must leave everything to the new one.
function holdsJob(row: Job, q: Pick<Tx, "select"> = db): boolean {
  if (!row.lockedBy) return false;
  const held = q
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.id, row.id), eq(job.status, "running"), eq(job.lockedBy, row.lockedBy)))
    .get();
  return held !== undefined;
}

function noticeKind(log: EmailLog, status: EmailLog["status"]): NotificationKind {
  if (status === "failed") return log.kind === "reminder" ? "reminder_failed" : "mail_failed";
  return status === "unknown" ? "mail_unknown" : "mail_held";
}

function raiseNotice(
  tx: Tx,
  log: EmailLog,
  kind: NotificationKind,
  dedupeKey = noticeKey(log.id),
): void {
  notify(tx, {
    userId: log.userId,
    kind,
    dedupeKey,
    params: { invoice: getInvoice(log.userId, log.invoiceId)?.number ?? null },
    entity: { type: "invoice", id: log.invoiceId },
  });
}

// Thrown to leave `mutate`, which refuses to commit without an audit row.
class AlreadyMoved extends Error {}

function moveLog(
  tx: Tx,
  log: EmailLog,
  from: EmailLog["status"],
  fields: Partial<typeof emailLog.$inferInsert>,
): void {
  const moved = tx
    .update(emailLog)
    .set({ ...fields, updatedAt: clock.now() })
    .where(
      scoped(log.userId).where(emailLog, (t, { and, eq: is }) =>
        and(is(t.id, log.id), is(t.status, from)),
      ),
    )
    .run();
  if (moved.changes === 0) throw new AlreadyMoved();
}

function settle(
  log: EmailLog,
  from: EmailLog["status"],
  status: "held" | "cancelled" | "failed" | "unknown",
  reason: string,
  quiet = false,
): void {
  try {
    mutate(actorOf(log), `mail.${status}`, (tx, audit) => {
      moveLog(tx, log, from, { status, reason: reason.slice(0, MAX_REASON_CHARS) });
      if (!quiet) raiseNotice(tx, log, noticeKind(log, status));
      audit({
        entity: "invoice",
        entityId: log.invoiceId,
        ownerId: log.userId,
        scope: "user",
        after: { logId: log.id, kind: log.kind, status, trigger: log.trigger },
      });
    });
  } catch (error) {
    if (!(error instanceof AlreadyMoved)) throw error;
  }
}

// `quiet`: the reason is what the person wanted, so there is nothing to tell them.
type Refusal = { status: "held" | "cancelled"; reason: string; quiet?: boolean };

// A payment or a snooze may arrive while the message waits for its next attempt.
function reminderLapsed(log: EmailLog, row: InvoiceDetail): boolean {
  if (amountDue(row) <= 0) return true;
  if (log.trigger !== "automatic") return false;
  const card = row.customerId ? getCustomer(log.userId, row.customerId) : null;
  const today = calendarDateInPrague(clock.now());
  const snoozed = row.remindersSnoozeUntil !== null && row.remindersSnoozeUntil > today;
  return snoozed || !isEligibleForReminder(row, card);
}

function refusal(log: EmailLog): Refusal | null {
  if (isDeactivated(log.userId)) return { status: "cancelled", reason: R.deactivated };
  const row = getInvoice(log.userId, log.invoiceId);
  if (!row || !isSendable(row.status)) return { status: "held", reason: R.status };
  // First: a payment raises the revision too, and it is no reason to alarm anyone.
  if (log.kind === "reminder" && reminderLapsed(log, row)) {
    return { status: "held", reason: TEXTS.reminders.held, quiet: true };
  }
  if (row.revision !== log.invoiceRevision) return { status: "held", reason: R.revision };
  if (log.trigger !== "automatic") return null;
  if (!log.automation || !automaticSendAllowed(log.userId, log.automation)) {
    return { status: "held", reason: R.automation };
  }
  const today = calendarDateInPrague(clock.now());
  const planned = log.plannedFor ?? calendarDateInPrague(log.createdAt);
  return daysBetween(planned, today) > MAX_AUTOMATIC_DELAY_DAYS
    ? { status: "held", reason: R.tooOld }
    : null;
}

function senderDomain(from: MailAddress): string {
  const address = typeof from === "string" ? from : from.address;
  return /@([^\s<>@]+)>?\s*$/.exec(address)?.[1] ?? "localhost";
}

async function archivedAttachment(log: EmailLog) {
  const actor = actorOf(log);
  let fileId = log.fileId;
  if (!fileId) {
    const pdf = await invoicePdf(log.userId, log.invoiceId);
    fileId = archiveSentPdf(actor, log.id, pdf.data, pdf.fileName).id;
  }
  const stored = readOwnedFile(actor, fileId);
  return { filename: stored.name, content: stored.data, contentType: stored.mimeType };
}

type Prepared = { transport: MailTransport; message: MailMessage };

async function prepare(log: EmailLog): Promise<Prepared | null> {
  const attachment = await withDeadline(() => archivedAttachment(log), limits.pdfMs);
  const transport = await resolveTransport(log.userId);
  if (!transport) return null;
  const { to, cc, bcc, subject, body } = log;
  return {
    transport,
    message: {
      // The record decides the copies: it was confirmed in the dialog and is what history shows.
      ...transport.identity,
      messageId: `<${log.id}@${senderDomain(transport.identity.from)}>`,
      to,
      cc,
      bcc,
      subject,
      text: body,
      attachments: [attachment],
    },
  };
}

class Refused extends Error {
  verdict: Refusal;

  constructor(verdict: Refusal) {
    super("Odeslání není povolené");
    this.verdict = verdict;
  }
}

// Consent is judged again here, in one transaction with the write: the PDF took time.
function startSending(row: Job, log: EmailLog, messageId: string): boolean {
  try {
    mutate(actorOf(log), "mail.sending", (tx, audit) => {
      const current = tx
        .select()
        .from(emailLog)
        .where(scoped(log.userId).where(emailLog, (t, { eq: is }) => is(t.id, log.id)))
        .get();
      if (current?.status !== "queued" || !holdsJob(row, tx)) throw new AlreadyMoved();
      const refused = refusal(current);
      if (refused) throw new Refused(refused);
      moveLog(tx, log, "queued", { status: "sending", attempts: current.attempts + 1, messageId });
      audit({
        entity: "invoice",
        entityId: log.invoiceId,
        ownerId: log.userId,
        scope: "user",
        after: { logId: log.id, kind: log.kind, attempt: current.attempts + 1 },
      });
    });
    return true;
  } catch (error) {
    if (error instanceof Refused) {
      const { status, reason, quiet } = error.verdict;
      settle(log, "queued", status, reason, quiet);
    } else if (!(error instanceof AlreadyMoved)) throw error;
    return false;
  }
}

function recordSentIn(log: EmailLog, { rejected }: SendResult, messageId: string): void {
  const reason = rejected.length > 0 ? R.partial(rejected.join(", ")) : null;
  mutate(actorOf(log), "mail.sent", (tx, audit) => {
    moveLog(tx, log, "sending", {
      status: "sent",
      reason: reason?.slice(0, MAX_REASON_CHARS) ?? null,
      sentAt: clock.now(),
    });
    if (reason) raiseNotice(tx, log, "mail_partial");
    const row = getInvoice(log.userId, log.invoiceId);
    // The message is out and cannot be recalled: the document keeps its state, the owner is told.
    if (!row || !isSendable(row.status) || row.revision !== log.invoiceRevision) {
      raiseNotice(tx, log, "mail_stale", `${noticeKey(log.id)}:stale`);
    }
    if (row && log.kind === kindForInvoice(row.type)) applySent(tx, log.userId, log.invoiceId);
    const earlier = tx
      .select({ id: emailLog.id })
      .from(emailLog)
      .where(
        scoped(log.userId).where(emailLog, (t, { and, eq: is }) =>
          and(
            is(t.invoiceId, log.invoiceId),
            is(t.kind, log.kind),
            log.stageKey === null ? isNull(t.stageKey) : is(t.stageKey, log.stageKey),
            inArray(t.status, ["failed", "unknown", "held", "cancelled"]),
          ),
        ),
      )
      .all();
    for (const { id } of earlier) resolveNotification(tx, log.userId, noticeKey(id));
    audit({
      entity: "invoice",
      entityId: log.invoiceId,
      ownerId: log.userId,
      scope: "user",
      after: {
        logId: log.id,
        kind: log.kind,
        status: "sent",
        trigger: log.trigger,
        messageId,
        rejected: rejected.length,
      },
    });
  });
}

function recordSent(log: EmailLog, result: SendResult, messageId: string): void {
  try {
    recordSentIn(log, result, messageId);
  } catch (error) {
    // Recovery took the record over and its notice stands: this is no failure of the code.
    if (!(error instanceof AlreadyMoved)) throw error;
  }
}

function requeue(log: EmailLog, reason: string): void {
  mutate(actorOf(log), "mail.retry", (tx, audit) => {
    moveLog(tx, log, "sending", { status: "queued", reason });
    audit({
      entity: "invoice",
      entityId: log.invoiceId,
      ownerId: log.userId,
      scope: "user",
      after: { logId: log.id, kind: log.kind, status: "queued" },
    });
  });
}

const retryDelay = (row: Job) => RETRY_DELAYS_MS[row.attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;

function failureContext(row: Job) {
  return {
    task: "job",
    jobId: row.id,
    kind: row.kind,
    ...(row.userId ? { userId: row.userId } : {}),
  };
}

// Only a code failure belongs in monitoring: every SMTP error carries a code (R-30).
function isCodeFailure(error: unknown): boolean {
  return (
    !(error instanceof DeadlineError) && typeof (error as { code?: unknown })?.code !== "string"
  );
}

// Returns the delay of another attempt, or null when this was the last word on the record.
function recordFailure(row: Job, log: EmailLog, error: unknown): number | null {
  const verdict = classifySmtpError(error);
  if (verdict === "ambiguous") {
    if (isCodeFailure(error)) reportFailure(error, failureContext(row));
    settle(log, "sending", "unknown", R.interrupted);
    return null;
  }
  const fallback = verdict === "retry" ? R.unreachable : R.refused;
  const reason = smtpFailureText(error) ?? fallback;
  if (verdict === "permanent" || exhausted(row)) {
    settle(log, "sending", "failed", reason);
    return null;
  }
  // retryJob would cancel the job, leaving a queued record no job will ever pick up.
  if (isDeactivated(log.userId)) {
    settle(log, "sending", "cancelled", R.deactivated);
    return null;
  }
  requeue(log, reason);
  return retryDelay(row);
}

export async function deliverMail(row: Job): Promise<void> {
  const log = readLog(row);
  if (!log) return;
  if (log.status === "sending") {
    settle(log, "sending", "unknown", R.interrupted);
    return;
  }
  if (log.status !== "queued") return;

  const refused = refusal(log);
  if (refused) {
    settle(log, "queued", refused.status, refused.reason, refused.quiet);
    return;
  }

  let prepared: Prepared | null;
  try {
    prepared = await prepare(log);
  } catch (error) {
    if (exhausted(row) && holdsJob(row)) settle(log, "queued", "failed", R.archive);
    throw error;
  }
  if (!holdsJob(row)) return;
  if (!prepared) {
    settle(log, "queued", "failed", R.unavailable);
    return;
  }

  const { transport, message } = prepared;
  const messageId = message.messageId!;
  if (!startSending(row, log, messageId)) return;

  // From here on an exception must never mean another attempt: the message may be on its way.
  let result: SendResult | null = null;
  let failure: unknown;
  try {
    result = await withDeadline(() => transport.send(message), limits.smtpMs);
  } catch (error) {
    failure = error;
  }

  let retryIn: number | null = null;
  try {
    if (result) recordSent(log, result, messageId);
    else retryIn = recordFailure(row, log, failure);
  } catch (error) {
    reportFailure(error, failureContext(row));
    settle(log, "sending", "unknown", R.interrupted);
    return;
  }
  if (retryIn !== null) throw new RetryLater("Odeslání se zopakuje", retryIn);
}

// A crash between requeue and retryJob must not turn the R-3 pause into an immediate attempt.
function recoveredRunAt(row: Job, log: EmailLog): Date {
  const now = clock.now();
  if (log.attempts === 0) return now;
  const due = log.updatedAt.getTime() + retryDelay(row);
  return due > now.getTime() ? new Date(due) : now;
}

export function recoverMail(row: Job): void {
  const worker = row.lockedBy;
  if (!worker) throw new Error("Obnovovaná úloha nemá držitele");
  const log = readLog(row);
  if (log?.status === "sending") {
    settle(log, "sending", "unknown", R.interrupted);
  } else if (log?.status === "queued") {
    const deactivated = isDeactivated(log.userId);
    if (deactivated) settle(log, "queued", "cancelled", R.deactivated);
    else if (exhausted(row)) settle(log, "queued", "failed", log.reason ?? R.notStarted);
    if (deactivated || !exhausted(row)) {
      // Cancels the job itself for a deactivated owner, so reactivation releases nothing (R-21).
      retryJob(row.id, worker, { runAt: recoveredRunAt(row, log), reason: "přerušený běh" });
      return;
    }
  }
  completeJob(row.id, worker);
}

// A dead job has no further run or recovery, and its record would block the partial index for good.
export function settleDeadMail(): void {
  const stranded = db
    .select({ log: emailLog, row: job })
    .from(job)
    .innerJoin(emailLog, sql`${emailLog.id} = json_extract(${job.payload}, '$.logId')`)
    .where(
      and(
        eq(job.status, "dead"),
        eq(job.kind, "mail.send"),
        inArray(emailLog.status, ["queued", "sending"]),
      ),
    )
    .all();
  for (const { log, row } of stranded) {
    try {
      if (log.status === "sending") settle(log, "sending", "unknown", R.interrupted);
      else settle(log, "queued", "failed", log.reason ?? R.notStarted);
    } catch (error) {
      reportFailure(error, { ...failureContext(row), task: "dead-mail" });
    }
  }
}
