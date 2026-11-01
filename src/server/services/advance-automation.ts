import "server-only";
import type { NotificationKind } from "@/lib/automation";
import { daysBetween } from "@/lib/invoice";
import { mailMessageSchema } from "@/lib/mail-send";
import type { CalendarDate } from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import type { Tx } from "../db";
import { ServiceError } from "./access";
import { createFinalIn } from "./advances";
import { automaticSendAllowed, getAutomation } from "./automation";
import { composeMail, type MailDraft } from "./email-templates";
import { finalOf, hasCancelledFinal, resolveWhenCovered } from "./invoice-balance";
import { issueIn } from "./invoice-lifecycle";
import { queueMail } from "./invoice-mail";
import { findOwned } from "./invoices";
import type { Audit } from "./mutation";
import { notify, resolveEntityNotifications } from "./notifications";
import { MAX_PAYMENT_AGE_DAYS } from "./payment-receipt";
import { getPreferences } from "./preferences";
import { noticeIssuedRate } from "./rate-notice";

export type AdvancePaidInput = {
  userId: string;
  advanceId: string;
  paidOn: CalendarDate;
  today: CalendarDate;
};

function safely<T>(tx: Tx, work: (savepoint: Tx) => T): { value: T } | { problems: string } {
  try {
    return { value: tx.transaction(work) };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { problems: error.message };
  }
}

function draftMail(userId: string, finalId: string): { draft: MailDraft } | { problems: string } {
  try {
    return { draft: composeMail(userId, finalId, "invoice") };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { problems: error.message };
  }
}

function queueFinal(
  tx: Tx,
  audit: Audit,
  { userId, paidOn, today }: AdvancePaidInput,
  finalId: string,
  dedupeKey: string,
): void {
  if (!automaticSendAllowed(userId, "advanceInvoice")) return;

  const invoice = findOwned(tx, userId, finalId).number;
  const entity = { type: "invoice", id: finalId };
  const raise = (kind: NotificationKind, extra = {}) =>
    notify(tx, { userId, kind, dedupeKey, params: { invoice, ...extra }, entity });

  if (daysBetween(paidOn, today) > MAX_PAYMENT_AGE_DAYS) return raise("advance_final_old_payment");

  const composed = draftMail(userId, finalId);
  if ("problems" in composed) {
    return raise("advance_final_bad_mail", { problems: composed.problems });
  }
  if (composed.draft.to.length === 0) return raise("advance_final_no_address");
  const message = mailMessageSchema.safeParse(composed.draft);
  if (!message.success) {
    const problems = message.error.issues[0]?.message ?? TEXTS.invoiceMail.errors.invalid;
    return raise("advance_final_bad_mail", { problems });
  }

  const { to, cc, bcc, subject, body } = message.data;
  queueMail(tx, audit, {
    userId,
    invoiceId: finalId,
    kind: "invoice",
    trigger: "automatic",
    automation: "advanceInvoice",
    plannedFor: paidOn,
    key: `mail:advance-final:${finalId}`,
    message: { to, cc, bcc, subject, body },
  });
}

// Part of the transaction that records the payment. Whatever the data refuses stays behind a
// savepoint and becomes a notice: the money arrived, and that must hold however this turns out.
export function afterAdvancePaid(tx: Tx, audit: Audit, input: AdvancePaidInput): void {
  const { userId, advanceId } = input;
  const mode = getPreferences(userId).advanceFinalMode;
  if (mode === "off") return;

  const advanceRow = findOwned(tx, userId, advanceId);
  const params = { advance: advanceRow.number };
  const active = finalOf(tx, userId, advanceId);
  if (active) {
    if (mode !== "issue" || active.status !== "draft") return;
    const entity = { type: "invoice", id: active.id };
    const dedupeKey = `advance-final:${active.id}`;
    return notify(tx, { userId, kind: "advance_final_manual", dedupeKey, params, entity });
  }
  // A cancelled final invoice was someone's decision, which a later payment must not reverse.
  if (hasCancelledFinal(tx, userId, advanceId)) {
    resolveEntityNotifications(tx, userId, "advance_final_cancelled", advanceId);
    return notify(tx, {
      userId,
      kind: "advance_final_cancelled",
      dedupeKey: `advance-final-cancelled:${advanceId}:${advanceRow.revision}`,
      params,
      entity: { type: "invoice", id: advanceId },
    });
  }

  const created = safely(tx, (savepoint) =>
    createFinalIn(savepoint, audit, userId, advanceRow, { automatic: true }),
  );
  if ("problems" in created) {
    return notify(tx, {
      userId,
      kind: "advance_final_failed",
      dedupeKey: `advance-final:${advanceId}:${advanceRow.revision}`,
      params: { ...params, problems: created.problems },
      entity: { type: "invoice", id: advanceId },
    });
  }
  if (mode === "draft") return;

  const finalId = created.value.id;
  const dedupeKey = `advance-final:${finalId}`;
  const entity = { type: "invoice", id: finalId };
  if (getAutomation(userId).paused) {
    return notify(tx, { userId, kind: "advance_final_held", dedupeKey, params, entity });
  }
  const { revision } = findOwned(tx, userId, finalId);
  const issued = safely(tx, (savepoint) =>
    issueIn(savepoint, audit, userId, finalId, { revision }),
  );
  if ("problems" in issued) {
    return notify(tx, {
      userId,
      kind: "advance_final_failed",
      dedupeKey,
      params: { ...params, draft: true, problems: issued.problems },
      entity,
    });
  }
  noticeIssuedRate(tx, userId, finalId, dedupeKey, { invoice: issued.value.number });
  queueFinal(tx, audit, input, finalId, dedupeKey);
}

// The key carries the revision because a resolved row would otherwise swallow a later refund.
export function advanceBalanceDropped(tx: Tx, userId: string, finalId: string): void {
  const final = findOwned(tx, userId, finalId);
  resolveEntityNotifications(tx, userId, "advance_final_review", finalId);
  if (final.status === "draft" || amountDue(final) <= 0) return;
  notify(tx, {
    userId,
    kind: "advance_final_review",
    dedupeKey: `advance-final-review:${finalId}:${final.revision}`,
    params: { invoice: final.number },
    entity: { type: "invoice", id: finalId },
  });
}

export function resolveFinalReview(tx: Tx, userId: string, finalId: string): void {
  resolveWhenCovered(tx, findOwned(tx, userId, finalId));
}
