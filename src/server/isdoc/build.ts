import { splitVatId } from "@/lib/clauses";
import { isDomesticCountry, DOMESTIC_COUNTRY } from "@/lib/customers";
import { RATE_UNIT, toCzkMinor } from "@/lib/fx";
import type { CustomerSnapshot, InvoiceDocument, SupplierSnapshot } from "@/lib/invoice-document";
import { ISDOC_NAMESPACE } from "@/lib/safe-input/pdf-embedded";
import { decimalMinor } from "@/lib/tabular";
import { PAYMENT_MEANS_CODES } from "./parse";

export const ISDOC_EXPORT_VERSION = "6.0.2";
const LOCAL_CURRENCY = "CZK";

export type IsdocContext = {
  // invoice.import_uuid when the document came from a file, otherwise invoice.id.
  uuid: string;
  relatedUuid?: string | null;
  deposits?: { number: string; variableSymbol: string; amountMinor: number }[];
};

export class IsdocBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsdocBuildError";
  }
}

const TYPE_CODES = { invoice: "1", advance: "4", credit_note: "2" } as const;
const PAYMENT_CODES = { transfer: "42", cash: "10", card: "48" } as const;

function escapeXml(value: string): string {
  return value
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function el(name: string, content: string | number, attributes = ""): string {
  return `<${name}${attributes}>${typeof content === "number" ? content : escapeXml(content)}</${name}>`;
}

function nest(name: string, ...content: string[]): string {
  return `<${name}>${content.join("")}</${name}>`;
}

const amount = (minor: number) => decimalMinor(minor, ".");

function milli(value: number): string {
  const whole = Math.trunc(value / 1000);
  const fraction = String(value % 1000).padStart(3, "0");
  return `${whole}.${fraction}`;
}

function micros(value: number): string {
  return `${Math.trunc(value / RATE_UNIT)}.${String(value % RATE_UNIT).padStart(6, "0")}`;
}

type Party = SupplierSnapshot | CustomerSnapshot;

// The app stores a country as free text; the code comes from it, else from the VAT ID prefix.
const COUNTRY_CODES: Record<string, string> = {
  slovensko: "SK",
  slovakia: "SK",
  německo: "DE",
  germany: "DE",
  deutschland: "DE",
  rakousko: "AT",
  austria: "AT",
  polsko: "PL",
  poland: "PL",
  maďarsko: "HU",
  hungary: "HU",
  francie: "FR",
  france: "FR",
  itálie: "IT",
  italy: "IT",
  nizozemsko: "NL",
  netherlands: "NL",
  belgie: "BE",
  belgium: "BE",
  španělsko: "ES",
  spain: "ES",
  švýcarsko: "CH",
  switzerland: "CH",
  "spojené království": "GB",
  "velká británie": "GB",
  "united kingdom": "GB",
  "spojené státy": "US",
  "spojené státy americké": "US",
  usa: "US",
  "united states": "US",
};

function countryCode(p: Party): string {
  const country = p.country.trim();
  if (/^[A-Za-z]{2}$/.test(country)) return country.toUpperCase();
  const known = COUNTRY_CODES[country.toLowerCase()];
  if (known) return known;
  const prefix = splitVatId(p.dic)?.country;
  return prefix === "EL" ? "GR" : (prefix ?? "");
}

function party(p: Party, contactName: string): string {
  const domestic = isDomesticCountry(p.country);
  const taxScheme = p.dic
    ? nest("PartyTaxScheme", el("CompanyID", p.dic), el("TaxScheme", "VAT"))
    : "";
  const contact =
    contactName || p.phone || p.email
      ? nest(
          "Contact",
          contactName ? el("Name", contactName) : "",
          p.phone ? el("Telephone", p.phone) : "",
          p.email ? el("ElectronicMail", p.email) : "",
        )
      : "";
  return nest(
    "Party",
    nest("PartyIdentification", el("ID", p.ico)),
    nest("PartyName", el("Name", p.name)),
    nest(
      "PostalAddress",
      el("StreetName", p.street),
      el("BuildingNumber", ""),
      el("CityName", p.city),
      el("PostalZone", p.zip),
      nest(
        "Country",
        el("IdentificationCode", domestic ? "CZ" : countryCode(p)),
        el("Name", domestic ? DOMESTIC_COUNTRY : p.country),
      ),
    ),
    taxScheme,
    contact,
  );
}

// ISDOC states every amount of a credit note as positive (R-12); the app keeps them negative.
export function buildIsdoc(doc: InvoiceDocument, context: IsdocContext): string {
  if (doc.status === "draft" || !doc.number || !doc.issueDate) {
    throw new IsdocBuildError("Koncept se do ISDOC neexportuje");
  }
  const { supplier, customer, account } = doc.snapshot;
  if (!supplier || !customer) throw new IsdocBuildError("Doklad nemá dodavatele nebo odběratele");
  const foreign = doc.currency !== LOCAL_CURRENCY;
  const rate = doc.exchangeRateMicros;
  if (foreign && !rate) throw new IsdocBuildError("Doklad v cizí měně nemá kurz");
  const sign = doc.type === "credit_note" ? -1 : 1;
  const local = (minor: number) => (foreign ? toCzkMinor(minor, rate!) : minor);
  // Each pair is the domestic amount and, in a foreign currency, its *Curr twin.
  const pair = (minor: number) => ({ curr: sign * minor, home: sign * local(minor) });

  const lines = doc.lines.map((line) => ({
    name: line.name,
    description: line.description,
    quantity: milli(line.quantityMilli),
    unit: line.unit,
    unitPrice: sign * local(line.unitPriceMinor),
    net: pair(line.netMinor),
  }));
  if (doc.totals.discountMinor !== 0) {
    lines.push({
      name: "Sleva",
      description: "",
      quantity: "1.000",
      unit: "",
      unitPrice: sign * local(-doc.totals.discountMinor),
      net: pair(-doc.totals.discountMinor),
    });
  }
  const sumCurr = lines.reduce((sum, line) => sum + line.net.curr, 0);
  const sumHome = lines.reduce((sum, line) => sum + line.net.home, 0);
  const rounding = pair(doc.totals.roundingMinor);
  const deposits = pair(doc.totals.advanceMinor + doc.totals.paidMinor);
  // What is left of this document after what was really paid on it. Credit notes travel as their
  // own documents and a replaced advance is still unpaid, so neither may lower PayableAmount: a
  // reader takes the gap between the total and PayableAmount for a payment (IMP-012).
  const payableCurr = Math.max(0, sumCurr + rounding.curr - deposits.curr);
  const payableHome = Math.max(0, sumHome + rounding.home - deposits.home);

  const money = (name: string, home: number, curr: number, currFirst: boolean) => {
    const homeXml = el(name, amount(home));
    const currXml = foreign ? el(`${name}Curr`, amount(curr)) : "";
    return currFirst ? currXml + homeXml : homeXml + currXml;
  };

  const lineXml = lines.map((line, index) =>
    nest(
      "InvoiceLine",
      el("ID", String(index + 1)),
      el("InvoicedQuantity", line.quantity, line.unit ? ` unitCode="${escapeXml(line.unit)}"` : ""),
      money("LineExtensionAmount", line.net.home, line.net.curr, true),
      money("LineExtensionAmountTaxInclusive", line.net.home, line.net.curr, true),
      el("LineExtensionTaxAmount", "0.00"),
      el("UnitPrice", amount(line.unitPrice)),
      el("UnitPriceTaxInclusive", amount(line.unitPrice)),
      nest(
        "ClassifiedTaxCategory",
        el("Percent", "0"),
        el("VATCalculationMethod", "0"),
        el("VATApplicable", "false"),
      ),
      line.description ? el("Note", line.description) : "",
      nest("Item", el("Description", line.name)),
    ),
  );

  const subTotal = nest(
    "TaxSubTotal",
    money("TaxableAmount", sumHome, sumCurr, true),
    money("TaxAmount", 0, 0, true),
    money("TaxInclusiveAmount", sumHome, sumCurr, true),
    ...[
      "AlreadyClaimedTaxableAmount",
      "AlreadyClaimedTaxAmount",
      "AlreadyClaimedTaxInclusiveAmount",
    ].map((n) => money(n, 0, 0, true)),
    money("DifferenceTaxableAmount", sumHome, sumCurr, true),
    money("DifferenceTaxAmount", 0, 0, true),
    money("DifferenceTaxInclusiveAmount", sumHome, sumCurr, true),
    nest("TaxCategory", el("Percent", "0"), el("VATApplicable", "false")),
  );

  const legal = nest(
    "LegalMonetaryTotal",
    money("TaxExclusiveAmount", sumHome, sumCurr, false),
    money("TaxInclusiveAmount", sumHome, sumCurr, false),
    money("AlreadyClaimedTaxExclusiveAmount", 0, 0, false),
    money("AlreadyClaimedTaxInclusiveAmount", 0, 0, false),
    money("DifferenceTaxExclusiveAmount", sumHome, sumCurr, false),
    money("DifferenceTaxInclusiveAmount", sumHome, sumCurr, false),
    rounding.curr !== 0 ? money("PayableRoundingAmount", rounding.home, rounding.curr, false) : "",
    money("PaidDepositsAmount", deposits.home, deposits.curr, false),
    money("PayableAmount", payableHome, payableCurr, false),
  );

  const related = doc.relatedDocument;
  const references = related
    ? nest(
        "OriginalDocumentReferences",
        nest(
          "OriginalDocumentReference",
          el("ID", related.number),
          el("IssueDate", related.issueDate),
          context.relatedUuid ? el("UUID", context.relatedUuid) : "",
        ),
      )
    : "";
  const depositXml = context.deposits?.length
    ? nest(
        "NonTaxedDeposits",
        ...context.deposits.map((deposit) =>
          nest(
            "NonTaxedDeposit",
            el("ID", deposit.number),
            el("VariableSymbol", deposit.variableSymbol),
            foreign ? el("DepositAmountCurr", amount(deposit.amountMinor)) : "",
            el("DepositAmount", amount(local(deposit.amountMinor))),
          ),
        ),
      )
    : "";

  const details =
    doc.dueDate || account
      ? nest(
          "Details",
          el("PaymentDueDate", doc.dueDate ?? doc.issueDate),
          el("ID", account?.number ?? ""),
          el("BankCode", account?.bankCode ?? ""),
          el("Name", account?.name ?? ""),
          el("IBAN", account?.iban ?? ""),
          el("BIC", account?.swift ?? ""),
          doc.variableSymbol ? el("VariableSymbol", doc.variableSymbol) : "",
        )
      : "";
  // PaymentMeans is optional, and no code of the schema means "unknown": an imported document
  // without bank details carries only the code its source file stated, or none at all.
  // A stored source code is data from a file or a backup, so only a code of the schema passes.
  const source = doc.sourcePaymentCode;
  const code = doc.paymentUnknown
    ? source && PAYMENT_MEANS_CODES.has(source)
      ? source
      : undefined
    : PAYMENT_CODES[doc.paymentMethod];
  const payment = !code
    ? ""
    : nest(
        "PaymentMeans",
        nest(
          "Payment",
          el("PaidAmount", amount(payableCurr)),
          el("PaymentMeansCode", code),
          details,
        ),
      );

  const note = [doc.clause, doc.textBefore, doc.textAfter, doc.note]
    .filter((part) => part.trim())
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Invoice xmlns="${ISDOC_NAMESPACE}" version="${ISDOC_EXPORT_VERSION}">` +
    el("DocumentType", TYPE_CODES[doc.type]) +
    el("ID", doc.number) +
    el("UUID", context.uuid) +
    el("IssuingSystem", "Fakturan") +
    el("IssueDate", doc.issueDate) +
    (doc.taxableDate ? el("TaxPointDate", doc.taxableDate) : "") +
    el("VATApplicable", "false") +
    el("ElectronicPossibilityAgreementReference", "") +
    (note ? el("Note", note) : "") +
    el("LocalCurrencyCode", LOCAL_CURRENCY) +
    (foreign ? el("ForeignCurrencyCode", doc.currency) : "") +
    el("CurrRate", foreign ? micros(rate!) : "1") +
    el("RefCurrRate", "1") +
    nest("AccountingSupplierParty", party(supplier, supplier.contactPerson)) +
    nest("AccountingCustomerParty", party(customer, "")) +
    references +
    nest("InvoiceLines", ...lineXml) +
    depositXml +
    nest("TaxTotal", subTotal, money("TaxAmount", 0, 0, true)) +
    legal +
    payment +
    "</Invoice>\n"
  );
}
