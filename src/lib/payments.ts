import { z } from "zod";
import { CURRENCIES } from "./currency";
import { AWAITING_PAYMENT, type InvoiceStatus } from "./invoice";
import { MAX_DOCUMENT_MINOR } from "./invoice-totals";
import { isCalendarDate } from "./number-format";
import { amountDue } from "./qr-payload";
import { TEXTS } from "./texts";

const E = TEXTS.payments.errors;

export const PAYMENT_CHANNELS = ["transfer", "cash", "other"] as const;
export const PAYMENT_SOURCES = ["manual", "notice", "import"] as const;
export const PAYMENT_KINDS = ["payment", "difference"] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const MAX_PAYMENT_NOTE = 500;

const TAKES_PAYMENT: readonly InvoiceStatus[] = [...AWAITING_PAYMENT, "paid"];

export function canTakePayment(status: InvoiceStatus): boolean {
  return TAKES_PAYMENT.includes(status);
}

// A zero total is never paid: nothing was owed, so any money on it stays a plain overpayment.
export function deriveStatus(input: {
  status: InvoiceStatus;
  sentAt: Date | null;
  totalMinor: number;
  paidMinor: number;
}): InvoiceStatus {
  if (!canTakePayment(input.status)) return input.status;
  const due = amountDue(input);
  if (input.totalMinor > 0 && due <= 0) return "paid";
  if (input.paidMinor > 0 && due > 0) return "partially_paid";
  return input.sentAt ? "sent" : "issued";
}

const minor = (message: string) =>
  z.number(message).int(message).min(1, message).max(MAX_DOCUMENT_MINOR, message);

export const paymentInputSchema = z.object(
  {
    revision: z.number(E.invalid).int(E.invalid),
    paidOn: z.string(E.date).refine(isCalendarDate, E.date),
    amountMinor: minor(E.amount),
    currency: z.enum(CURRENCIES, E.invalid),
    creditedMinor: minor(E.credited).nullish(),
    method: z.enum(PAYMENT_CHANNELS, E.invalid),
    note: z.string(E.invalid).trim().max(MAX_PAYMENT_NOTE, E.note),
  },
  E.invalid,
);
export type PaymentInput = z.input<typeof paymentInputSchema>;
