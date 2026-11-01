import { DOCUMENT_TYPES, type CalendarDate, type DocumentType } from "./number-format";
import type { Discount, DiscountKind } from "./invoice-totals";
import type { LogoPosition, Preferences } from "./preferences";
import { amountDue, type Balance } from "./qr-payload";

export const INVOICE_STATUSES = [
  "draft",
  "issued",
  "sent",
  "partially_paid",
  "paid",
  "cancelled",
  "credited",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_TYPES = DOCUMENT_TYPES;
export type InvoiceType = DocumentType;

export type Appearance = {
  designId: string;
  colors: { accent: string; surface: string; text: string; line: string };
  logoPosition: LogoPosition;
  showLogo: boolean;
  showQr: boolean;
  showQrLogo: boolean;
  showSignature: boolean;
  showDuzp: boolean;
};

export function appearanceFrom(prefs: Preferences): Appearance {
  return {
    designId: prefs.designId,
    colors: {
      accent: prefs.accentColor,
      surface: prefs.surfaceColor,
      text: prefs.textColor,
      line: prefs.lineColor,
    },
    logoPosition: prefs.logoPosition,
    showLogo: prefs.showLogo,
    showQr: prefs.showQr,
    showQrLogo: prefs.showQrLogo,
    showSignature: prefs.showSignature,
    showDuzp: prefs.showDuzp,
  };
}

export function toDiscount(kind: DiscountKind, value: number): Discount {
  if (kind === "percent") return { kind, basisPoints: value };
  if (kind === "amount") return { kind, minor: value };
  return { kind };
}

const MS_PER_DAY = 86_400_000;

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return new Date(Date.parse(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

// Bulk actions render or change documents one by one, so the batch has to stay bounded.
export const MAX_BULK_DOCUMENTS = 200;

export const AWAITING_PAYMENT = ["issued", "sent", "partially_paid"] as const;

export const ACTIVE_CREDIT_STATUSES = ["issued", "sent"] as const;

const CREDITABLE_STATUSES: readonly InvoiceStatus[] = ["issued", "sent", "partially_paid", "paid"];

export function isCreditable(row: { type: InvoiceType; status: InvoiceStatus }): boolean {
  return row.type === "invoice" && CREDITABLE_STATUSES.includes(row.status);
}

export const ADVANCE_FORM_PARAM = "zalohova";

export function isConvertibleAdvance(row: { type: InvoiceType; status: InvoiceStatus }): boolean {
  return row.type === "advance" && CREDITABLE_STATUSES.includes(row.status);
}

export function isFinalInvoice(row: {
  type: InvoiceType;
  relatedInvoiceId: string | null;
}): boolean {
  return row.type === "invoice" && row.relatedInvoiceId !== null;
}

export function isActiveDocument(status: InvoiceStatus): boolean {
  return (ACTIVE_CREDIT_STATUSES as readonly InvoiceStatus[]).includes(status);
}

export function isOverdue(
  row: Balance & { status: InvoiceStatus; dueDate: CalendarDate | null },
  today: CalendarDate,
): boolean {
  return (
    (AWAITING_PAYMENT as readonly InvoiceStatus[]).includes(row.status) &&
    amountDue(row) > 0 &&
    row.dueDate !== null &&
    row.dueDate < today
  );
}
