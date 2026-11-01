import "server-only";
import { daysBetween } from "@/lib/invoice";
import { mailMessageSchema } from "@/lib/mail-send";
import type { CalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Tx } from "../db";
import { ServiceError } from "./access";
import { automaticSendAllowed } from "./automation";
import { composeMail, type MailDraft } from "./email-templates";
import { queueMail, receiptPayment } from "./invoice-mail";
import { findOwned } from "./invoices";
import type { Audit } from "./mutation";
import { notify } from "./notifications";

// The first read covers 30 days of history, which must not turn into a burst of old thank-yous.
const MAX_AGE_DAYS = 3;

export type ReceiptInput = {
  userId: string;
  invoiceId: string;
  paymentId: string;
  paidOn: CalendarDate;
  today: CalendarDate;
};

function draftReceipt(
  tx: Tx,
  { userId, invoiceId, paymentId }: ReceiptInput,
): { draft: MailDraft } | { problems: string } {
  try {
    const payment = receiptPayment(tx, userId, invoiceId, paymentId);
    return {
      draft: composeMail(userId, invoiceId, "payment_receipt", undefined, null, { payment }),
    };
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return { problems: error.message };
  }
}

// Part of the transaction that records the payment, after applyPayments, so the record carries the
// new revision. It must never throw over the message: that would take the payment back with it.
export function queueAutomaticReceipt(tx: Tx, audit: Audit, input: ReceiptInput): void {
  const { userId, invoiceId, paymentId, paidOn, today } = input;
  if (!automaticSendAllowed(userId, "paymentReceipt")) return;
  if (daysBetween(paidOn, today) > MAX_AGE_DAYS) return;

  const params = { invoice: findOwned(tx, userId, invoiceId).number };
  const entity = { type: "invoice", id: invoiceId };
  const raise = (kind: "receipt_no_address" | "receipt_bad_mail", extra = {}) =>
    notify(tx, {
      userId,
      kind,
      dedupeKey: `receipt:${paymentId}`,
      params: { ...params, ...extra },
      entity,
    });

  const composed = draftReceipt(tx, input);
  if ("problems" in composed) return raise("receipt_bad_mail", { problems: composed.problems });
  if (composed.draft.to.length === 0) return raise("receipt_no_address");
  const message = mailMessageSchema.safeParse(composed.draft);
  if (!message.success) {
    const problems = message.error.issues[0]?.message ?? TEXTS.invoiceMail.errors.invalid;
    return raise("receipt_bad_mail", { problems });
  }

  const { to, cc, bcc, subject, body } = message.data;
  queueMail(tx, audit, {
    userId,
    invoiceId,
    kind: "payment_receipt",
    trigger: "automatic",
    automation: "paymentReceipt",
    plannedFor: paidOn,
    key: `mail:receipt:${paymentId}`,
    paymentId,
    message: { to, cc, bcc, subject, body },
  });
}
