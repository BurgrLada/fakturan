import type { InvoiceType } from "@/lib/invoice";
import type { Language, PaymentMethod } from "@/lib/preferences";

export type DocumentLabels = {
  locale: string;
  documentTypes: Record<InvoiceType, string>;
  paymentMethods: Record<PaymentMethod, string>;
  draft: string;
  cancelled: string;
  supplier: string;
  customer: string;
  ico: string;
  dic: string;
  issueDate: string;
  dueDate: string;
  taxableDate: string;
  orderRef: string;
  reference: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
  subtotal: string;
  rounding: string;
  total: string;
  paid: string;
  due: string;
  payment: string;
  paymentMethod: string;
  account: string;
  iban: string;
  swift: string;
  variableSymbol: string;
  qrCaption: string;
  qrAfterIssue: string;
  note: string;
  signature: string;
  page: (current: number, total: number) => string;
  sample: {
    customer: string;
    street: string;
    city: string;
    zip: string;
    country: string;
    lineName: string;
    lineDescription: string;
    secondLineName: string;
  };
};

export const LABELS: Record<Language, DocumentLabels> = {
  cs: {
    locale: "cs-CZ",
    documentTypes: {
      invoice: "Faktura",
      advance: "Zálohová faktura",
      credit_note: "Opravný daňový doklad",
    },
    paymentMethods: { transfer: "Převodem", cash: "Hotově", card: "Kartou" },
    draft: "Koncept",
    cancelled: "Stornováno",
    supplier: "Dodavatel",
    customer: "Odběratel",
    ico: "IČO",
    dic: "DIČ",
    issueDate: "Datum vystavení",
    dueDate: "Datum splatnosti",
    taxableDate: "DUZP",
    orderRef: "Objednávka",
    reference: "Reference",
    description: "Popis",
    quantity: "Množství",
    unitPrice: "Cena za jednotku",
    discount: "Sleva",
    lineTotal: "Celkem",
    subtotal: "Mezisoučet",
    rounding: "Zaokrouhlení",
    total: "Celkem k úhradě",
    paid: "Uhrazeno",
    due: "Zbývá uhradit",
    payment: "Platební údaje",
    paymentMethod: "Způsob platby",
    account: "Číslo účtu",
    iban: "IBAN",
    swift: "SWIFT",
    variableSymbol: "Variabilní symbol",
    qrCaption: "QR platba",
    qrAfterIssue: "QR po vystavení",
    note: "Poznámka",
    signature: "Podpis",
    page: (current, total) => `Strana ${current} z ${total}`,
    sample: {
      customer: "Ukázkový zákazník s.r.o.",
      street: "Vzorová 12",
      city: "Praha",
      zip: "110 00",
      country: "Česká republika",
      lineName: "Konzultace",
      lineDescription: "Návrh řešení a příprava podkladů",
      secondLineName: "Grafické práce",
    },
  },
  en: {
    locale: "en-GB",
    documentTypes: {
      invoice: "Invoice",
      advance: "Advance invoice",
      credit_note: "Credit note",
    },
    paymentMethods: { transfer: "Bank transfer", cash: "Cash", card: "Card" },
    draft: "Draft",
    cancelled: "Cancelled",
    supplier: "Supplier",
    customer: "Customer",
    ico: "Company ID",
    dic: "VAT ID",
    issueDate: "Issue date",
    dueDate: "Due date",
    taxableDate: "Date of supply",
    orderRef: "Order",
    reference: "Reference",
    description: "Description",
    quantity: "Quantity",
    unitPrice: "Unit price",
    discount: "Discount",
    lineTotal: "Total",
    subtotal: "Subtotal",
    rounding: "Rounding",
    total: "Total due",
    paid: "Paid",
    due: "Amount due",
    payment: "Payment details",
    paymentMethod: "Payment method",
    account: "Account number",
    iban: "IBAN",
    swift: "SWIFT",
    variableSymbol: "Payment reference",
    qrCaption: "QR payment",
    qrAfterIssue: "QR after issuing",
    note: "Note",
    signature: "Signature",
    page: (current, total) => `Page ${current} of ${total}`,
    sample: {
      customer: "Sample Customer Ltd.",
      street: "12 Example Street",
      city: "Prague",
      zip: "110 00",
      country: "Czech Republic",
      lineName: "Consulting",
      lineDescription: "Solution design and preparation",
      secondLineName: "Graphic design",
    },
  },
};
