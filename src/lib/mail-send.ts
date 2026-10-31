import { z } from "zod";
import { mailContentSchema } from "./email-template";
import type { InvoiceStatus } from "./invoice";
import { TEXTS } from "./texts";

const E = TEXTS.invoiceMail.errors;

export const EMAIL_STATUSES = [
  "queued",
  "sending",
  "sent",
  "failed",
  "unknown",
  "held",
  "cancelled",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_TRIGGERS = ["manual", "automatic", "bulk"] as const;
export type EmailTrigger = (typeof EMAIL_TRIGGERS)[number];

export const SENDABLE_STATUSES = [
  "issued",
  "sent",
  "partially_paid",
  "paid",
] as const satisfies readonly InvoiceStatus[];

export function isSendable(status: InvoiceStatus): boolean {
  return (SENDABLE_STATUSES as readonly InvoiceStatus[]).includes(status);
}

export const MAX_RECIPIENTS = 20;

const addresses = z.array(z.email(E.address).trim(), E.address).max(MAX_RECIPIENTS, E.recipients);

const messageFields = mailContentSchema.extend({
  to: addresses.min(1, E.noRecipient),
  cc: addresses,
  bcc: addresses,
});

type Recipients = Pick<z.output<typeof messageFields>, "to" | "cc" | "bcc">;

const withinRecipientLimit = ({ to, cc, bcc }: Recipients) =>
  to.length + cc.length + bcc.length <= MAX_RECIPIENTS;

export const mailMessageSchema = messageFields.refine(withinRecipientLimit, E.recipients);

export const sendInputSchema = messageFields
  .extend({
    requestId: z.uuid(E.invalid),
    confirmedUnknown: z.boolean(E.invalid).optional(),
    revision: z.number(E.invalid).int(E.invalid),
    logId: z.string(E.invalid).min(1, E.invalid).optional(),
  })
  .refine(withinRecipientLimit, E.recipients);

export type SendInput = z.input<typeof sendInputSchema>;
