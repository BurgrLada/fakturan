import "server-only";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { AutomationKey } from "@/lib/automation";
import { kindForInvoice, type MessageKind } from "@/lib/email-template";
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
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { FileNotFoundError, readOwnedFile } from "./files";
import { InvoicePdfNotFoundError } from "./invoice-pdf";
import { findOwned, getInvoice } from "./invoices";
import { mailAvailability } from "./mail-settings";
import { mutate } from "./mutation";
import { notify } from "./notifications";

const E = TEXTS.invoiceMail.errors;

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

function queueClicked(
  actor: Actor,
  userId: string,
  invoiceId: string,
  requestId: string,
  message: Message,
  opts: { confirmedUnknown: boolean; kind?: MessageKind },
): { logId: string } {
  const key = requestKey(userId, requestId);
  const logged = loggedRequest(userId, key);
  if (logged) return { logId: logged };
  if (!mailAvailability(userId).available) throw new ServiceError(E.unavailable);

  const queued = mutate(actor, "invoice.send", (tx, audit) => {
    const row = findOwned(tx, userId, invoiceId);
    if (!isSendable(row.status)) throw new ServiceError(E.notSendable);
    const kind = opts.kind ?? kindForInvoice(row.type);
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
    });
    if (!result) throw new ServiceError(E.alreadySending);
    return result;
  });
  kickWorker();
  return queued;
}

export function sendInvoice(actor: Actor, invoiceId: string, raw: SendInput): { logId: string } {
  const userId = ownerOf(actor);
  enforceRateLimit(actor, RATE_RULES.sendUser);
  const parsed = sendInputSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  const { requestId, confirmedUnknown = false, ...message } = parsed.data;
  return queueClicked(actor, userId, invoiceId, requestId, message, { confirmedUnknown });
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

  if (!RESENDABLE.includes(log.status)) throw new ServiceError(E.notResendable);
  if (log.status === "unknown" && !opts.confirmedUnknown) throw new ServiceError(E.confirmUnknown);
  if (supersededBy(log)) throw new ServiceError(E.superseded);
  const { to, cc, bcc, subject, body } = log;
  return queueClicked(
    actor,
    userId,
    log.invoiceId,
    opts.requestId,
    { to, cc, bcc, subject, body },
    { confirmedUnknown: opts.confirmedUnknown, kind: log.kind },
  );
}

// A failed, held or cancelled attempt leaves a rendered PDF behind that no client ever received.
const mayHaveLeft = (log: Pick<EmailLog, "status">) =>
  log.status === "sent" || log.status === "unknown";

export function listEmailLog(ownerId: string, invoiceId: string) {
  return db
    .select()
    .from(emailLog)
    .where(scoped(ownerId).where(emailLog, (t, { eq }) => eq(t.invoiceId, invoiceId)))
    .orderBy(desc(emailLog.createdAt), sql`rowid DESC`)
    .all()
    .map(({ fileId, ...row }) => ({ ...row, hasArchive: fileId !== null && mayHaveLeft(row) }));
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
