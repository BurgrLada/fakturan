import type { Currency } from "./currency";
import type { Appearance, InvoiceType } from "./invoice";
import type { DiscountKind, RoundingMode } from "./invoice-totals";
import type { Language, PaymentMethod } from "./preferences";

export type TemplateLine = {
  catalogItemId: string | null;
  name: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceMinor: number;
  discountKind: DiscountKind;
  discountValue: number;
};

// A draft without its customer, number, series and dates: the due date is kept as a number of days.
export type TemplateDocument = {
  type: InvoiceType;
  bankAccountId: string | null;
  dueDays: number;
  language: Language;
  currency: Currency;
  paymentMethod: PaymentMethod;
  orderRef: string;
  reference: string;
  textBefore: string;
  textAfter: string;
  note: string;
  discountKind: DiscountKind;
  discountValue: number;
  rounding: RoundingMode;
  appearance: Appearance;
  lines: TemplateLine[];
};
