import "server-only";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AutomationKey } from "@/lib/automation";
import { kindForInvoice, type MessageKind } from "@/lib/email-template";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import type { Language } from "@/lib/preferences";
import { amountDue } from "@/lib/qr-payload";
import { isSendable, sendInputSchema, type EmailTrigger, type SendInput } from "@/lib/mail-send";
import type { CalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { emailLog, invoice, job, type EmailLog } from "../db/schema";
import { scoped } from "../db/scoped";
import { enqueue } from "../jobs/queue";
import { kickWorker } from "../jobs/worker";
import type { MailContent } from "../mail/defaults";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { getAutomation } from "./automation";
import { composeMail, type MailDraft } from "./email-templates";
import { FileNotFoundError, readOwnedFile } from "./files";
import { InvoicePdfNotFoundError } from "./invoice-pdf";
import { findOwned, getInvoice, type Invoice } from "./invoices";
import { mailAvailability } from "./mail-settings";
import { mutate } from "./mutation";
import { notify, resolveNotification } from "./notifications";

const E = TEXTS.invoiceMail.errors;
const B = TEXTS.invoiceMail.bulk.reasons;

// One attempt plus three repeats (R-3).
const MAX_ATTEMPTS = 4;
const RESENDABLE: readonly EmailLog["status"][] = ["failed", "unknown", "held", "cancelled"];

type Audit = Parameters<Parameters<typeof mutate>[2]>[1];

type Message = Pick<EmailLog, "to" | "cc" | "bcc" | "subject" | "body">;

export type QueueInput = {
  userId: string;
  invoiceId: string;
  kind: MessageKind;
  trigger: EmailTrigger;
  key: string;
  message: Message;
  plannedFor?: CalendarDate;
  automation?: AutomationKey;
  stageKey?: string;
};

export const mailNoticeKey = (logId: string) => `mail:${logId}`;

// Part of the deactivating transaction, so no worker can claim the job in between (R-21).
export function cancelQueuedMail(tx: Tx, userId: string): number {
  const queued = tx
    .select({ id: emailLog.id, invoiceId: emailLog.invoiceId, number: invoice.number })
    .from(emailLog)
    .innerJoin(invoice, eq(invoice.id, emailLog.invoiceId))
    .where(scoped(userId).where(emailLog, (t, ops) => ops.eq(t.status, "queued")))
    .all();
  tx.update(emailLog)
    .set({
      status: "cancelled",
      reason: TEXTS.invoiceMail.reasons.deactivated,
      updatedAt: clock.now(),
    })
    .where(scoped(userId).where(emailLog, (t, ops) => ops.eq(t.status, "queued")))
    .run();
  for (const { id, invoiceId, number } of queued) {
    notify(tx, {
      userId,
      kind: "mail_held",
      dedupeKey: mailNoticeKey(id),
      params: { invoice: number },
      entity: { type: "invoice", id: invoiceId },
    });
  }
  return queued.length;
}

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

export function queueMail(tx: Tx, audit: Audit, input: QueueInput): { logId: string } | null {
  const { userId, invoiceId, kind, trigger, key, message } = input;
  if (
    tx
      .select({ id: job.id })
      .from(job)
      .where(scoped(userId).where(job, (t, { eq }) => eq(t.key, key)))
      .get()
  ) {
    return null;
  }
  const row = findOwned(tx, userId, invoiceId);
  const logId = randomUUID();
  const now = clock.now();
  const inserted = tx
    .insert(emailLog)
    .values({
      id: logId,
      userId,
      invoiceId,
      kind,
      trigger,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      body: message.body,
      invoiceRevision: row.revision,
      plannedFor: input.plannedFor ?? null,
      automation: input.automation ?? null,
      stageKey: input.stageKey ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: emailLog.id })
    .get();
  if (!inserted) return null;
  enqueue(tx, { kind: "mail.send", key, userId, payload: { logId }, maxAttempts: MAX_ATTEMPTS });
  audit({
    action: "invoice.send",
    entity: "invoice",
    entityId: invoiceId,
    ownerId: userId,
    scope: "user",
    after: {
      logId,
      kind,
      trigger,
      subject: message.subject,
      recipients: message.to.length + message.cc.length + message.bcc.length,
    },
  });
  return { logId };
}

// Scoped to the account, so one account's request id cannot collide with or reveal another's.
const requestKey = (userId: string, requestId: string) => `mail:${userId}:${requestId}`;

function loggedRequest(userId: string, key: string): string | null {
  const row = db
    .select({ payload: job.payload })
    .from(job)
    .where(scoped(userId).where(job, (t, { eq }) => eq(t.key, key)))
    .get();
  return row ? String(row.payload.logId) : null;
}

// Bulk sending must skip such a document: it has nowhere to ask for the confirmation.
export function hasUnresolvedUnknown(
  ownerId: string,
  invoiceId: string,
  kind: MessageKind,
): boolean {
  const row = db
    .select({ id: emailLog.id })
    .from(emailLog)
    .where(
      scoped(ownerId).where(emailLog, (t, { and, eq: is }) =>
        and(
          is(t.invoiceId, invoiceId),
          is(t.kind, kind),
          is(t.status, "unknown"),
          isNull(t.acknowledgedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM email_log AS newer
            WHERE newer.invoice_id = email_log.invoice_id AND newer.kind = email_log.kind
              AND newer.status = 'sent' AND newer.rowid > email_log.rowid
          )`,
        ),
      ),
    )
    .get();
  return row !== undefined;
}

type ClickOptions = {
  confirmedUnknown: boolean;
  kind?: MessageKind;
  stageKey?: string | null;
  revision: number;
  // Runs in the queueing transaction: a throw takes the queued message back with it.
  alongside?: (tx: Tx, audit: Audit, row: Invoice, logId: string) => void;
};

function queueClicked(
  actor: Actor,
  userId: string,
  invoiceId: string,
  requestId: string,
  message: Message,
  opts: ClickOptions,
): { logId: string } {
  const key = requestKey(userId, requestId);
  const logged = loggedRequest(userId, key);
  if (logged) return { logId: logged };
  if (!mailAvailability(userId).available) throw new ServiceError(E.unavailable);

  const queued = mutate(actor, "invoice.send", (tx, audit) => {
    const row = findOwned(tx, userId, invoiceId);
    if (!isSendable(row.status)) throw new ServiceError(E.notSendable);
    // The text was written for one version of the document and the PDF is rendered from the latest.
    if (row.revision !== opts.revision) throw new ServiceError(E.staleDraft);
    const kind = opts.kind ?? kindForInvoice(row.type);
    if (kind === "reminder" && amountDue(row) <= 0) {
      throw new ServiceError(TEXTS.reminders.errors.nothingDue);
    }
    if (kind === "reminder" && !row.sentAt) throw new ServiceError(TEXTS.reminders.errors.notSent);
    if (!opts.confirmedUnknown && hasUnresolvedUnknown(userId, invoiceId, kind)) {
      throw new ServiceError(E.unknownPending);
    }
    const result = queueMail(tx, audit, {
      userId,
      invoiceId,
      kind,
      trigger: "manual",
      key,
      message,
      stageKey: opts.stageKey ?? undefined,
    });
    if (!result) throw new ServiceError(E.alreadySending);
    opts.alongside?.(tx, audit, row, result.logId);
    return result;
  });
  kickWorker();
  return queued;
}

function parseSend(raw: SendInput) {
  const parsed = sendInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  return parsed.data;
}

export function queueReminder(
  actor: Actor,
  invoiceId: string,
  raw: SendInput,
  stageKey: string,
  alongside: NonNullable<ClickOptions["alongside"]>,
): { logId: string } {
  const userId = ownerOf(actor);
  const {
    requestId,
    confirmedUnknown = false,
    revision,
    to,
    cc,
    bcc,
    subject,
    body,
  } = parseSend(raw);
  return queueClicked(
    actor,
    userId,
    invoiceId,
    requestId,
    { to, cc, bcc, subject, body },
    { confirmedUnknown, revision, kind: "reminder", stageKey, alongside },
  );
}

export function sendInvoice(actor: Actor, invoiceId: string, raw: SendInput): { logId: string } {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.sendUser);
  const { requestId, confirmedUnknown = false, revision, logId, ...message } = parseSend(raw);
  const replaced =
    logId && !loggedRequest(userId, requestKey(userId, requestId))
      ? replacedLog(userId, invoiceId, logId)
      : undefined;
  return queueClicked(actor, userId, invoiceId, requestId, message, {
    confirmedUnknown,
    revision,
    kind: replaced?.kind,
    stageKey: replaced?.stageKey,
  });
}

function readLog(userId: string, logId: string): EmailLog | undefined {
  return db
    .select()
    .from(emailLog)
    .where(scoped(userId).where(emailLog, (t, { eq }) => eq(t.id, logId)))
    .get();
}

// A stale tab must not repeat a message that a later click already delivered, or may have.
function supersededBy(log: EmailLog): boolean {
  const newer = db
    .select({ id: emailLog.id })
    .from(emailLog)
    .where(
      scoped(log.userId).where(emailLog, (t, { and, eq }) =>
        and(
          eq(t.invoiceId, log.invoiceId),
          eq(t.kind, log.kind),
          inArray(t.status, ["sent", "unknown"]),
          sql`rowid > (SELECT rowid FROM email_log WHERE id = ${log.id})`,
        ),
      ),
    )
    .get();
  return newer !== undefined;
}

function assertResendable(log: EmailLog): void {
  if (!RESENDABLE.includes(log.status) || log.acknowledgedAt) {
    throw new ServiceError(E.notResendable);
  }
  if (supersededBy(log)) throw new ServiceError(E.superseded);
}

// A message rebuilt after a change replaces this record, so its kind comes from here, not the client.
function replacedLog(userId: string, invoiceId: string, logId: string): EmailLog {
  const log = readLog(userId, logId);
  if (log?.invoiceId !== invoiceId) throw new ServiceError(E.logNotFound);
  assertResendable(log);
  return log;
}

export function resendFromLog(
  actor: Actor,
  logId: string,
  opts: { confirmedUnknown: boolean; requestId: string },
): { logId: string } {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.sendUser);
  const log = readLog(userId, logId);
  if (!log) throw new ServiceError(E.logNotFound);
  const logged = loggedRequest(userId, requestKey(userId, opts.requestId));
  if (logged) return { logId: logged };

  assertResendable(log);
  if (log.status === "unknown" && !opts.confirmedUnknown) throw new ServiceError(E.confirmUnknown);
  const { to, cc, bcc, subject, body } = log;
  return queueClicked(
    actor,
    userId,
    log.invoiceId,
    opts.requestId,
    { to, cc, bcc, subject, body },
    {
      confirmedUnknown: opts.confirmedUnknown,
      kind: log.kind,
      stageKey: log.stageKey,
      revision: log.invoiceRevision,
    },
  );
}

// Only a person can tell whether the message arrived. Open for any document state, because
// marking the invoice as sent by hand takes away everything else that could close the record.
export function acknowledgeUnknown(actor: Actor, logId: string): void {
  const userId = ownerOf(actor);
  mutate(actor, "mail.acknowledged", (tx, audit) => {
    const now = clock.now();
    const row = tx
      .update(emailLog)
      .set({ acknowledgedAt: now, updatedAt: now })
      .where(
        scoped(userId).where(emailLog, (t, { and, eq }) =>
          and(eq(t.id, logId), eq(t.status, "unknown"), isNull(t.acknowledgedAt)),
        ),
      )
      .returning({ invoiceId: emailLog.invoiceId, kind: emailLog.kind })
      .get();
    if (!row) throw new ServiceError(E.notAcknowledgeable);
    resolveNotification(tx, userId, mailNoticeKey(logId));
    audit({
      entity: "invoice",
      entityId: row.invoiceId,
      ownerId: userId,
      scope: "user",
      after: { logId, kind: row.kind },
    });
  });
}

// A failed, held or cancelled attempt leaves a rendered PDF behind that no client ever received.
const mayHaveLeft = (log: Pick<EmailLog, "status">) =>
  log.status === "sent" || log.status === "unknown";

export function listEmailLog(ownerId: string, invoiceId: string) {
  const delivered = new Set<MessageKind>();
  return db
    .select()
    .from(emailLog)
    .where(scoped(ownerId).where(emailLog, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .orderBy(desc(emailLog.createdAt), sql`rowid DESC`)
    .all()
    .map(({ fileId, ...row }) => {
      const resendable =
        RESENDABLE.includes(row.status) && !delivered.has(row.kind) && !row.acknowledgedAt;
      if (mayHaveLeft(row)) delivered.add(row.kind);
      return {
        ...row,
        hasArchive: fileId !== null && mayHaveLeft(row),
        resendable,
        acknowledgeable: row.status === "unknown" && !row.acknowledgedAt,
      };
    });
}

export type EmailLogRow = ReturnType<typeof listEmailLog>[number];

// An unknown outranks a newer failure: the client may hold that message, and only a person can tell.
export function mailStateOf(rows: EmailLogRow[]): {
  sending: boolean;
  retrying: boolean;
  problem: EmailLogRow | null;
} {
  const open = rows.filter((row) => row.resendable);
  return {
    sending: rows.some((row) => row.status === "queued" || row.status === "sending"),
    retrying: rows.some((row) => row.status === "queued" && row.attempts > 0),
    problem: open.find((row) => row.status === "unknown") ?? open[0] ?? null,
  };
}

export type SendPrefill = MailDraft & {
  requestId: string;
  revision: number;
  unknownPending: boolean;
  paused: boolean;
  repeat?: boolean;
  log: {
    id: string;
    status: EmailLog["status"];
    reason: string | null;
    current: boolean;
  } | null;
};

// The request id is born here, so reopening the dialog is a new send and a double click is not.
export function sendPrefill(
  ownerId: string,
  invoiceId: string,
  logId?: string,
  fresh?: { kind: MessageKind; texts: Partial<Record<Language, MailContent>> | null },
): SendPrefill {
  const row = getInvoice(ownerId, invoiceId);
  if (!row) throw new ServiceError(E.notFound);
  if (!isSendable(row.status)) throw new ServiceError(E.notSendable);
  const log = logId ? readLog(ownerId, logId) : undefined;
  if (logId && log?.invoiceId !== invoiceId) throw new ServiceError(E.logNotFound);
  const kind = log?.kind ?? fresh?.kind ?? kindForInvoice(row.type);
  const draft = composeMail(ownerId, invoiceId, kind, undefined, fresh?.texts);
  // After a change the recorded text describes a document the attachment no longer matches.
  const current = log?.invoiceRevision === row.revision;
  return {
    ...draft,
    ...(log &&
      current && {
        to: log.to,
        cc: log.cc,
        bcc: log.bcc,
        subject: log.subject,
        body: log.body,
      }),
    requestId: randomUUID(),
    revision: row.revision,
    unknownPending: log?.status === "unknown" || hasUnresolvedUnknown(ownerId, invoiceId, kind),
    paused: getAutomation(ownerId).paused,
    log: log ? { id: log.id, status: log.status, reason: log.reason, current } : null,
  };
}

function isRunning(ownerId: string, invoiceId: string, kind: MessageKind): boolean {
  const row = db
    .select({ id: emailLog.id })
    .from(emailLog)
    .where(
      scoped(ownerId).where(emailLog, (t, { and, eq }) =>
        and(eq(t.invoiceId, invoiceId), eq(t.kind, kind), inArray(t.status, ["queued", "sending"])),
      ),
    )
    .get();
  return row !== undefined;
}

type BulkVerdict =
  | { number: string; customer: string; kind: MessageKind; draft: MailDraft; reason?: never }
  | { number: string; reason: string };

// Bulk has no way to ask, so everything a single send would confirm or refuse is a skip here.
function judgeBulk(ownerId: string, invoiceId: string): BulkVerdict {
  const row = getInvoice(ownerId, invoiceId);
  if (!row) return { number: "", reason: B.notFound };
  const number = row.number ?? TEXTS.invoices.statuses.draft;
  if (row.status !== "issued") return { number, reason: B.status };
  const kind = kindForInvoice(row.type);
  if (hasUnresolvedUnknown(ownerId, invoiceId, kind)) return { number, reason: B.unknown };
  if (isRunning(ownerId, invoiceId, kind)) return { number, reason: B.sending };
  let draft: MailDraft;
  try {
    draft = composeMail(ownerId, invoiceId, kind);
  } catch (error) {
    if (error instanceof ServiceError) return { number, reason: error.message };
    throw error;
  }
  if (draft.to.length === 0) return { number, reason: B.noAddress };
  const checked = sendInputSchema.safeParse({
    ...draft,
    requestId: randomUUID(),
    revision: row.revision,
  });
  if (!checked.success) {
    return { number, reason: checked.error.issues[0]?.message ?? E.invalid };
  }
  return { number, customer: row.customerName, kind, draft };
}

export function bulkSendPreview(ownerId: string, ids: string[]) {
  const ready: { id: string; number: string; customer: string; to: string[]; copies: string[] }[] =
    [];
  const skipped: { id: string; number: string; reason: string }[] = [];
  for (const id of new Set(ids)) {
    const verdict = judgeBulk(ownerId, id);
    if (verdict.reason !== undefined) {
      skipped.push({ id, number: verdict.number, reason: verdict.reason });
      continue;
    }
    const { number, customer, draft } = verdict;
    ready.push({ id, number, customer, to: draft.to, copies: [...draft.cc, ...draft.bcc] });
  }
  return { ready, skipped };
}

export type BulkSkip = { number: string; reason: string };

export type BulkPreviewed = Record<string, { to: string[]; copies: string[] }>;

const sameRecipients = (a: BulkPreviewed[string], b: BulkPreviewed[string]) =>
  JSON.stringify([a.to, a.copies]) === JSON.stringify([b.to, b.copies]);

// `previewed` holds what the person confirmed: a changed recipient is a skip, not a silent send.
export function bulkSend(
  actor: Actor,
  ids: string[],
  requestId: string,
  previewed?: BulkPreviewed,
): { queued: number; skipped: number; reasons: BulkSkip[] } {
  const userId = ownerOf(actor);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_DOCUMENTS) {
    throw new ServiceError(TEXTS.invoices.list.bulk.tooMany(MAX_BULK_DOCUMENTS));
  }
  enforceRateLimit(actor, RATE_RULES.sendBulkUser);
  enforceRateLimit(actor, RATE_RULES.sendUser);
  if (!mailAvailability(userId).available) throw new ServiceError(E.unavailable);

  let queued = 0;
  const reasons: BulkSkip[] = [];
  for (const invoiceId of unique) {
    const key = `${requestKey(userId, requestId)}:${invoiceId}`;
    if (loggedRequest(userId, key)) {
      queued += 1;
      continue;
    }
    try {
      mutate(actor, "invoice.send", (tx, audit) => {
        const verdict = judgeBulk(userId, invoiceId);
        if (verdict.reason !== undefined) throw new ServiceError(verdict.reason);
        const { to, cc, bcc, subject, body } = verdict.draft;
        const confirmed = previewed?.[invoiceId];
        if (
          previewed &&
          !(confirmed && sameRecipients(confirmed, { to, copies: [...cc, ...bcc] }))
        ) {
          throw new ServiceError(B.recipientsChanged);
        }
        const message = { to, cc, bcc, subject, body };
        const { kind } = verdict;
        const result = queueMail(tx, audit, {
          userId,
          invoiceId,
          kind,
          trigger: "bulk",
          key,
          message,
        });
        if (!result) throw new ServiceError(E.alreadySending);
      });
      queued += 1;
    } catch (error) {
      if (!(error instanceof ServiceError)) Sentry.captureException(error);
      reasons.push({
        number: getInvoice(userId, invoiceId)?.number ?? "",
        reason: error instanceof ServiceError ? error.message : B.unexpected,
      });
    }
  }
  if (queued > 0) kickWorker();
  return { queued, skipped: unique.length - queued, reasons };
}

export function archivedPdf(
  actor: Actor,
  logId: string,
  invoiceId?: string,
): { data: Buffer; fileName: string } {
  const userId = ownerOf(actor);
  const log = readLog(userId, logId);
  if (!log?.fileId || !mayHaveLeft(log)) throw new InvoicePdfNotFoundError();
  if (invoiceId !== undefined && log.invoiceId !== invoiceId) throw new InvoicePdfNotFoundError();
  let stored;
  try {
    stored = readOwnedFile(actor, log.fileId);
  } catch (error) {
    if (error instanceof FileNotFoundError) throw new InvoicePdfNotFoundError();
    throw error;
  }
  mutate(actor, "invoice.pdf_download", (_tx, audit) =>
    audit({
      entity: "invoice",
      entityId: log.invoiceId,
      ownerId: userId,
      scope: "user",
      after: { number: getInvoice(userId, log.invoiceId)?.number ?? null, archive: true, logId },
    }),
  );
  return { data: stored.data, fileName: stored.name };
}
