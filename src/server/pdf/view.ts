import "server-only";
import type { Currency } from "@/lib/currency";
import { toDiscount } from "@/lib/invoice";
import type { DocumentLine, InvoiceDocument } from "@/lib/invoice-document";
import { appliedLineDiscount } from "@/lib/invoice-totals";
import type { CalendarDate } from "@/lib/number-format";
import type { Language } from "@/lib/preferences";
import { amountDue, documentQrInput, planQr } from "@/lib/qr-payload";
import { formatCalendarDate } from "@/lib/template-vars";
import { imageToPng } from "./assets";
import { getDesign } from "./designs";
import { LABELS, type DocumentLabels } from "./labels";
import { qrPng } from "./qr";

const MILLI = 1000;
const MAX_KEPT_DESCRIPTION = 600;
const MAX_KEPT_DESCRIPTION_ROWS = 20;

export type LabeledValue = { label: string; value: string };

export type PartyView = {
  name: string;
  address: string[];
  identifiers: LabeledValue[];
  contact: string[];
};

export type LineView = {
  name: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
  keepTogether: boolean;
};

export type TotalRow = LabeledValue & { strong: boolean };

export type InvoiceView = {
  designId: string;
  language: Language;
  labels: DocumentLabels;
  colors: { accent: string; surface: string; text: string; line: string };
  title: string;
  number: string;
  watermark: string | null;
  logoPosition: "left" | "right" | "none";
  supplier: PartyView | null;
  customer: PartyView;
  details: LabeledValue[];
  lines: LineView[];
  hasLineDiscount: boolean;
  totals: TotalRow[];
  payment: { rows: LabeledValue[]; qr: Buffer | null; qrPending: boolean };
  textBefore: string;
  textAfter: string;
  note: string;
  clause: string;
  vatStatement: string;
  registryNote: string;
  footer: string;
  images: { logo: Buffer | null; signature: Buffer | null };
};

export type ViewOptions = {
  today: CalendarDate;
  draft: boolean;
  readImage: (fileId: string) => Buffer | null;
};

// JetBrains Mono has no U+202F, and the two read the same on paper.
function printable(text: string): string {
  return text.replace(/ /g, " ");
}

function money(minor: number, currency: Currency, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  return printable(format.format(minor / 100));
}

function decimal(value: number, locale: string, maximumFractionDigits: number): string {
  return printable(new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value));
}

function lineDiscount(line: DocumentLine, currency: Currency, locale: string): string {
  if (line.discountKind === "percent") {
    return `${decimal(line.discountValue / 100, locale, 2)} %`;
  }
  if (line.discountKind !== "amount") return "";
  const applied = appliedLineDiscount({
    quantityMilli: line.quantityMilli,
    unitPriceMinor: line.unitPriceMinor,
    discount: toDiscount(line.discountKind, line.discountValue),
  });
  return money(applied, currency, locale);
}

function lineView(line: DocumentLine, currency: Currency, locale: string): LineView {
  const description = printable(line.description);
  const quantity = decimal(line.quantityMilli / MILLI, locale, 3);
  return {
    name: printable(line.name),
    description,
    quantity: [quantity, printable(line.unit)].filter(Boolean).join(" "),
    unitPrice: money(line.unitPriceMinor, currency, locale),
    discount: lineDiscount(line, currency, locale),
    total: money(line.netMinor, currency, locale),
    // A row kept whole that outgrows the page would be clipped, and newlines grow it too.
    keepTogether:
      description.length <= MAX_KEPT_DESCRIPTION &&
      description.split("\n").length <= MAX_KEPT_DESCRIPTION_ROWS,
  };
}

function partyAddress(party: { street: string; zip: string; city: string; country: string }) {
  const city = [party.zip, party.city].filter(Boolean).join(" ");
  return [party.street, city, party.country].filter(Boolean).map(printable);
}

function identifiers(party: { ico: string; dic: string }, labels: DocumentLabels): LabeledValue[] {
  const rows = [
    { label: labels.ico, value: party.ico },
    { label: labels.dic, value: party.dic },
  ];
  return rows.filter((row) => row.value).map((row) => ({ ...row, value: printable(row.value) }));
}

function supplierView(doc: InvoiceDocument, labels: DocumentLabels): PartyView | null {
  const party = doc.snapshot.supplier;
  if (!party) return null;
  return {
    name: printable(party.name),
    address: partyAddress(party),
    identifiers: identifiers(party, labels),
    contact: [party.contactPerson, party.email, party.phone, party.web]
      .filter(Boolean)
      .map(printable),
  };
}

function customerView(doc: InvoiceDocument, labels: DocumentLabels): PartyView {
  const party = doc.snapshot.customer;
  if (!party) {
    return {
      name: printable(doc.customerName),
      address: [],
      identifiers: [],
      contact: [],
    };
  }
  return {
    name: printable(party.name),
    address: partyAddress(party),
    identifiers: identifiers(party, labels),
    contact: [party.email, party.phone].filter(Boolean).map(printable),
  };
}

function detailRows(doc: InvoiceDocument, opts: ViewOptions, labels: DocumentLabels) {
  const format = doc.dateFormat ?? "d. M. yyyy";
  const date = (value: CalendarDate | null) => (value ? formatCalendarDate(value, format) : "");
  const { relatedDocument: related } = doc;
  const rows = [
    {
      label: labels.correctsDocument,
      value:
        doc.type === "credit_note" && related
          ? printable(labels.correctsDate(related.number, date(related.issueDate)))
          : "",
    },
    { label: labels.issueDate, value: date(doc.issueDate ?? (opts.draft ? opts.today : null)) },
    { label: labels.dueDate, value: date(doc.dueDate) },
    { label: labels.taxableDate, value: doc.appearance.showDuzp ? date(doc.taxableDate) : "" },
    { label: labels.orderRef, value: printable(doc.orderRef) },
    { label: labels.reference, value: printable(doc.reference) },
  ];
  return rows.filter((row) => row.value);
}

function totalRows(doc: InvoiceDocument, labels: DocumentLabels): TotalRow[] {
  const { totals, currency } = doc;
  const amount = (minor: number) => money(minor, currency, labels.locale);
  const row = (label: string, value: string, strong = false): TotalRow => ({
    label,
    value,
    strong,
  });
  const adjusted = totals.discountMinor !== 0 || totals.roundingMinor !== 0;
  const settled = totals.creditsMinor || totals.advanceMinor || totals.paidMinor;
  const due = amountDue(totals);
  return [
    ...(adjusted ? [row(labels.subtotal, amount(totals.subtotalMinor))] : []),
    ...(totals.discountMinor ? [row(labels.discount, amount(-totals.discountMinor))] : []),
    ...(totals.roundingMinor ? [row(labels.rounding, amount(totals.roundingMinor))] : []),
    row(
      doc.type === "credit_note" ? labels.creditTotal : labels.total,
      amount(totals.totalMinor),
      !settled,
    ),
    ...(totals.creditsMinor ? [row(labels.credits, amount(totals.creditsMinor))] : []),
    ...(totals.advanceMinor ? [row(labels.paidByAdvance, amount(totals.advanceMinor))] : []),
    ...(totals.paidMinor ? [row(labels.paid, amount(totals.paidMinor))] : []),
    ...(settled ? [row(due < 0 ? labels.overpaid : labels.due, amount(Math.abs(due)), true)] : []),
  ];
}

function groupIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, "$1 ");
}

function paymentRows(doc: InvoiceDocument, labels: DocumentLabels): LabeledValue[] {
  const account = doc.paymentMethod === "transfer" ? doc.snapshot.account : null;
  const rows = [
    { label: labels.paymentMethod, value: labels.paymentMethods[doc.paymentMethod] },
    {
      label: labels.account,
      value: account?.number ? `${account.number}/${account.bankCode}` : "",
    },
    { label: labels.iban, value: account?.iban ? groupIban(account.iban) : "" },
    { label: labels.swift, value: account?.swift ?? "" },
    { label: labels.variableSymbol, value: doc.variableSymbol ?? "" },
  ];
  return rows.filter((row) => row.value);
}

async function paymentQr(
  doc: InvoiceDocument,
  title: string,
  opts: ViewOptions,
): Promise<{ qr: Buffer | null; qrPending: boolean }> {
  const plan = planQr(documentQrInput(doc, title));
  if (plan.kind === "none") return { qr: null, qrPending: false };
  // A draft has neither number nor variable symbol, so a code printed now could not be matched.
  if (opts.draft) return { qr: null, qrPending: true };
  const logo = doc.appearance.showQrLogo
    ? await loadImage(doc.images.qrLogoFileId, opts.readImage)
    : null;
  return { qr: await qrPng(plan.payload, logo, plan.kind), qrPending: false };
}

async function loadImage(
  fileId: string | null,
  readImage: ViewOptions["readImage"],
): Promise<Buffer | null> {
  const data = fileId ? readImage(fileId) : null;
  return data ? imageToPng(data) : null;
}

// Issued documents carry already substituted text, so renderVariables must not run here again.
export async function buildInvoiceView(
  doc: InvoiceDocument,
  opts: ViewOptions,
): Promise<InvoiceView> {
  const labels = LABELS[doc.language];
  const design = getDesign(doc.appearance.designId);
  const { appearance, snapshot } = doc;
  const supplier = snapshot.supplier;
  const documentType = labels.documentTypes[doc.type];
  const number = opts.draft ? "" : (doc.number ?? "");
  const title = [documentType, number].filter(Boolean).join(" ");
  const showLogo = appearance.showLogo && appearance.logoPosition !== "none";
  const [logo, signature, qr] = await Promise.all([
    showLogo ? loadImage(doc.images.logoFileId, opts.readImage) : null,
    appearance.showSignature ? loadImage(doc.images.signatureFileId, opts.readImage) : null,
    paymentQr(doc, title, opts),
  ]);
  const { colors } = design.tokens;
  return {
    designId: design.id,
    language: doc.language,
    labels,
    colors: {
      accent: appearance.colors.accent || colors.accent,
      surface: appearance.colors.surface || colors.surface,
      text: appearance.colors.text || colors.text,
      line: appearance.colors.line || colors.line,
    },
    title: documentType,
    number: printable(number),
    watermark: opts.draft ? labels.draft : doc.status === "cancelled" ? labels.cancelled : null,
    logoPosition: appearance.logoPosition,
    supplier: supplierView(doc, labels),
    customer: customerView(doc, labels),
    details: detailRows(doc, opts, labels),
    lines: doc.lines.map((line) => lineView(line, doc.currency, labels.locale)),
    hasLineDiscount: doc.lines.some((line) => line.discountKind !== "none"),
    totals: totalRows(doc, labels),
    payment: { rows: paymentRows(doc, labels), ...qr },
    textBefore: printable(doc.textBefore),
    textAfter: printable(doc.textAfter),
    note: printable(doc.note),
    clause: printable(doc.clause),
    vatStatement: printable(
      (doc.language === "en" ? supplier?.notVatPayerEn : supplier?.notVatPayerCs) ?? "",
    ),
    registryNote: printable(supplier?.registryNote ?? ""),
    footer: printable(supplier?.footerText ?? ""),
    images: { logo, signature },
  };
}
