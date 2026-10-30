import { calendarDateInPrague, type CalendarDate } from "./number-format";
import type { Currency } from "./currency";

export const LANGUAGES = ["cs", "en"] as const;
export const PAYMENT_METHODS = ["transfer", "cash", "card"] as const;
export const ISSUE_DATE_MODES = ["today", "last_day_previous_month"] as const;
export const DATE_FORMATS = ["d. M. yyyy", "dd.MM.yyyy", "yyyy-MM-dd"] as const;
export const VARIABLE_SYMBOL_FORMATS = ["digits", "empty"] as const;

export type Language = (typeof LANGUAGES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type IssueDateMode = (typeof ISSUE_DATE_MODES)[number];
export type DateFormat = (typeof DATE_FORMATS)[number];
export type VariableSymbolFormat = (typeof VARIABLE_SYMBOL_FORMATS)[number];

export type Preferences = {
  dueDays: number;
  language: Language;
  currency: Currency;
  designId: string;
  accentColor: string;
  paymentMethod: PaymentMethod;
  unit: string;
  showLogo: boolean;
  showQr: boolean;
  showQrLogo: boolean;
  showSignature: boolean;
  showDuzp: boolean;
  textBefore: string;
  textAfter: string;
  note: string;
  issueDateMode: IssueDateMode;
  dateFormat: DateFormat;
  variableSymbolFormat: VariableSymbolFormat;
};

export const DEFAULT_PREFERENCES: Preferences = {
  dueDays: 14,
  language: "cs",
  currency: "CZK",
  designId: "cisty",
  accentColor: "",
  paymentMethod: "transfer",
  unit: "ks",
  showLogo: true,
  showQr: true,
  showQrLogo: false,
  showSignature: false,
  showDuzp: false,
  textBefore: "",
  textAfter: "",
  note: "",
  issueDateMode: "today",
  dateFormat: "d. M. yyyy",
  variableSymbolFormat: "digits",
};

export function defaultIssueDate(mode: IssueDateMode, now: Date): CalendarDate {
  const today = calendarDateInPrague(now);
  if (mode === "today") return today;
  const [year, month] = today.split("-").map(Number) as [number, number];
  // Day 0 of this month is the last day of the previous one.
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
}
