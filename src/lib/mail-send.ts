import { z } from "zod";
import { mailContentSchema, MESSAGE_KINDS } from "./email-template";
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

export const sendInputSchema = mailContentSchema
  .extend({
    requestId: z.uuid(E.invalid),
    to: addresses.min(1, E.noRecipient),
    cc: addresses,
    bcc: addresses,
    confirmedUnknown: z.boolean(E.invalid).optional(),
    revision: z.number(E.invalid).int(E.invalid),
    kind: z.enum(MESSAGE_KINDS, E.invalid).optional(),
  })
  .refine(({ to, cc, bcc }) => to.length + cc.length + bcc.length <= MAX_RECIPIENTS, E.recipients);

export type SendInput = z.input<typeof sendInputSchema>;
