import type { CalendarDate, DocumentType } from "./number-format";

export type ImportParty = {
  name: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  ico: string;
  dic: string;
  email: string;
  phone: string;
};

// Amounts follow the app's sign convention: a credit note is negative even though ISDOC is not.
export type ImportLine = {
  name: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceMinor: number;
  netMinor: number;
};

export type ImportAccount = { number: string; bankCode: string; iban: string; swift: string };

export type ImportReference = {
  number: string;
  uuid: string | null;
  issueDate: CalendarDate | null;
};

export type ImportDeposit = { number: string; variableSymbol: string; amountMinor: number };

export type ImportDocument = {
  // Null for a source type the app does not take (ISDOC 3, 5, 6); sourceType says which one.
  type: DocumentType | null;
  sourceType: string;
  isdocVersion: string | null;
  number: string;
  uuid: string | null;
  issueDate: CalendarDate;
  taxableDate: CalendarDate | null;
  dueDate: CalendarDate | null;
  supplier: ImportParty;
  customer: ImportParty | null;
  lines: ImportLine[];
  currency: string;
  // CZK per one unit of currency, in millionths; null when the file has no usable rate.
  exchangeRateMicros: number | null;
  subtotalMinor: number;
  roundingMinor: number;
  totalMinor: number;
  payableMinor: number;
  paidDepositsMinor: number;
  variableSymbol: string | null;
  account: ImportAccount | null;
  originalDocuments: ImportReference[];
  deposits: ImportDeposit[];
  vatApplicable: boolean;
  note: string;
  issuingSystem: string | null;
  // Only a table states when a document was paid; ISDOC never does (IMP-012).
  paidOn?: CalendarDate | null;
};
