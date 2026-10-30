import { DOCUMENT_TYPES, type CalendarDate, type DocumentType } from "./number-format";
import type { Discount, DiscountKind } from "./invoice-totals";
import type { LogoPosition, Preferences } from "./preferences";

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

const AWAITING_PAYMENT: readonly InvoiceStatus[] = ["issued", "sent", "partially_paid"];

export function isOverdue(
  row: { status: InvoiceStatus; dueDate: CalendarDate | null },
  today: CalendarDate,
): boolean {
  return AWAITING_PAYMENT.includes(row.status) && row.dueDate !== null && row.dueDate < today;
}
