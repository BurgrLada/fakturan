import { calendarDateInPrague, type CalendarDate } from "./number-format";
import type { Currency } from "./currency";
import type { RoundingMode } from "./invoice-totals";

export const LANGUAGES = ["cs", "en"] as const;
export const PAYMENT_METHODS = ["transfer", "cash", "card"] as const;
export const ISSUE_DATE_MODES = ["today", "last_day_previous_month"] as const;
export const DATE_FORMATS = ["d. M. yyyy", "dd.MM.yyyy", "yyyy-MM-dd"] as const;
export const VARIABLE_SYMBOL_FORMATS = ["digits", "empty"] as const;
export const LOGO_POSITIONS = ["left", "right", "none"] as const;
export const FX_BASES = ["issue_date", "taxable_date"] as const;
export const ADVANCE_FINAL_MODES = ["off", "draft", "issue"] as const;
export const TURNOVER_BASES = ["taxable", "paid"] as const;

export type Language = (typeof LANGUAGES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type IssueDateMode = (typeof ISSUE_DATE_MODES)[number];
export type DateFormat = (typeof DATE_FORMATS)[number];
export type VariableSymbolFormat = (typeof VARIABLE_SYMBOL_FORMATS)[number];
export type LogoPosition = (typeof LOGO_POSITIONS)[number];
export type FxBasis = (typeof FX_BASES)[number];
export type AdvanceFinalMode = (typeof ADVANCE_FINAL_MODES)[number];
export type TurnoverBasis = (typeof TURNOVER_BASES)[number];

export type Preferences = {
  dueDays: number;
  language: Language;
  currency: Currency;
  designId: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  lineColor: string;
  logoPosition: LogoPosition;
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
  rounding: RoundingMode;
  pdfFileName: string;
  fxBasis: FxBasis;
  fixedRates: Record<string, number>;
  advanceFinalMode: AdvanceFinalMode;
  // null = the statutory limit from lib/turnover-limits.
  turnoverVatLimitMinor: number | null;
  turnoverFlatLimitMinor: number | null;
  turnoverBasis: TurnoverBasis;
};

export type DesignChoice = { id: string; name: string };

export const DEFAULT_PREFERENCES: Preferences = {
  dueDays: 14,
  language: "cs",
  currency: "CZK",
  designId: "cisty",
  accentColor: "",
  surfaceColor: "",
  textColor: "",
  lineColor: "",
  logoPosition: "left",
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
  rounding: "none",
  pdfFileName: "{cislo}.pdf",
  fxBasis: "issue_date",
  fixedRates: {},
  advanceFinalMode: "draft",
  turnoverVatLimitMinor: null,
  turnoverFlatLimitMinor: null,
  turnoverBasis: "taxable",
};

export function defaultIssueDate(mode: IssueDateMode, now: Date): CalendarDate {
  const today = calendarDateInPrague(now);
  if (mode === "today") return today;
  const [year, month] = today.split("-").map(Number) as [number, number];
  // Day 0 of this month is the last day of the previous one.
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
}
