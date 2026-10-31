import type { Appearance, InvoiceStatus, InvoiceType } from "./invoice";
import type { DiscountKind, RoundingMode } from "./invoice-totals";
import type { Currency } from "./currency";
import type { CalendarDate } from "./number-format";
import type { DateFormat, Language, PaymentMethod } from "./preferences";

export type SupplierSnapshot = {
  name: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  ico: string;
  dic: string;
  email: string;
  phone: string;
  web: string;
  registryNote: string;
  contactPerson: string;
  vatIdentified: boolean;
  footerText: string;
  notVatPayerCs: string;
  notVatPayerEn: string;
};

export type CustomerSnapshot = {
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

export type AccountSnapshot = {
  name: string;
  currency: Currency;
  number: string;
  bankCode: string;
  iban: string;
  swift: string;
};

// Null is possible on a draft, which may lack its parties; an issued document always has supplier
// and customer, and has an account unless it is paid otherwise than by transfer.
export type InvoiceSnapshot = {
  supplier: SupplierSnapshot | null;
  customer: CustomerSnapshot | null;
  account: AccountSnapshot | null;
};

export type DocumentImages = {
  logoFileId: string | null;
  qrLogoFileId: string | null;
  signatureFileId: string | null;
};

export type DocumentTotals = {
  subtotalMinor: number;
  discountMinor: number;
  roundingMinor: number;
  totalMinor: number;
  paidMinor: number;
};

export type DocumentLine = {
  catalogItemId: string | null;
  name: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceMinor: number;
  discountKind: DiscountKind;
  discountValue: number;
  netMinor: number;
};

type DocumentHeader = {
  id: string;
  type: InvoiceType;
  status: InvoiceStatus;
  number: string | null;
  variableSymbol: string | null;
  variableSymbolManual: boolean;
  seriesId: string | null;
  customerId: string | null;
  customerName: string;
  bankAccountId: string | null;
  issueDate: CalendarDate | null;
  dueDate: CalendarDate | null;
  taxableDate: CalendarDate | null;
  language: Language;
  currency: Currency;
  exchangeRateMicros: number | null;
  paymentMethod: PaymentMethod;
  orderRef: string;
  reference: string;
  textBefore: string;
  textAfter: string;
  note: string;
  discountKind: DiscountKind;
  discountValue: number;
  rounding: RoundingMode;
  // Null only on a draft row; loadInvoiceDocument fills it with the current preference.
  dateFormat: DateFormat | null;
  periodFrom: CalendarDate | null;
  periodTo: CalendarDate | null;
};

export type InvoiceDocument = DocumentHeader & {
  appearance: Appearance;
  lines: DocumentLine[];
  snapshot: InvoiceSnapshot;
  images: DocumentImages;
  totals: DocumentTotals;
};

type DocumentRow = DocumentHeader &
  DocumentImages &
  DocumentTotals & {
    appearance: Appearance;
    supplierSnapshot: SupplierSnapshot | null;
    customerSnapshot: CustomerSnapshot | null;
    accountSnapshot: AccountSnapshot | null;
    lines: DocumentLine[];
  };

// Copies field by field: the document ends up in stored versions, which must not carry columns such
// as the owner or the search text.
export function invoiceDocument(row: DocumentRow): InvoiceDocument {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    number: row.number,
    variableSymbol: row.variableSymbol,
    variableSymbolManual: row.variableSymbolManual,
    seriesId: row.seriesId,
    customerId: row.customerId,
    customerName: row.customerName,
    bankAccountId: row.bankAccountId,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    taxableDate: row.taxableDate,
    language: row.language,
    currency: row.currency,
    exchangeRateMicros: row.exchangeRateMicros,
    paymentMethod: row.paymentMethod,
    orderRef: row.orderRef,
    reference: row.reference,
    textBefore: row.textBefore,
    textAfter: row.textAfter,
    note: row.note,
    discountKind: row.discountKind,
    discountValue: row.discountValue,
    rounding: row.rounding,
    dateFormat: row.dateFormat,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    appearance: row.appearance,
    lines: row.lines.map((line) => ({
      catalogItemId: line.catalogItemId,
      name: line.name,
      description: line.description,
      quantityMilli: line.quantityMilli,
      unit: line.unit,
      unitPriceMinor: line.unitPriceMinor,
      discountKind: line.discountKind,
      discountValue: line.discountValue,
      netMinor: line.netMinor,
    })),
    snapshot: {
      supplier: row.supplierSnapshot,
      customer: row.customerSnapshot,
      account: row.accountSnapshot,
    },
    images: {
      logoFileId: row.logoFileId,
      qrLogoFileId: row.qrLogoFileId,
      signatureFileId: row.signatureFileId,
    },
    totals: {
      subtotalMinor: row.subtotalMinor,
      discountMinor: row.discountMinor,
      roundingMinor: row.roundingMinor,
      totalMinor: row.totalMinor,
      paidMinor: row.paidMinor,
    },
  };
}
