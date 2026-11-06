import { canonicalCountry, DOMESTIC_COUNTRY } from "@/lib/customers";
import {
  importedCountry,
  type ImportAccount,
  type ImportDeposit,
  type ImportDocument,
  type ImportLine,
  type ImportParty,
  type ImportReference,
} from "@/lib/import-document";
import { MAX_EXCHANGE_RATE_MICROS } from "@/lib/fx";
import type { CalendarDate, DocumentType } from "@/lib/number-format";
import { decimalToMicros, decimalToMinor, quantityToMilli } from "@/lib/safe-input/decimal";
import { InputRejected, XML_LIMITS } from "@/lib/safe-input/limits";
import { ISDOC_NAMESPACE } from "@/lib/safe-input/pdf-embedded";
import { children, firstChild, parseXml, type XmlNode } from "@/lib/safe-input/xml";

// The enumeration of PaymentMeansCodeType in the 6.0.x schemas; the export allows only these too.
export const PAYMENT_MEANS_CODES: ReadonlySet<string> = new Set([
  "10",
  "20",
  "31",
  "42",
  "48",
  "49",
  "50",
  "97",
]);

export const SUPPORTED_VERSIONS = ["6.0.1", "6.0.2"] as const;

export class IsdocInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsdocInvalid";
  }
}

const TYPES: Record<string, DocumentType | null> = {
  "1": "invoice",
  "7": "invoice",
  "4": "advance",
  "2": "credit_note",
  "3": null,
  "5": null,
  "6": null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RATE_UNIT = BigInt(1_000_000);
const TWO = BigInt(2);
// The same ceiling as a rate typed in by hand.
const MAX_RATE = BigInt(MAX_EXCHANGE_RATE_MICROS);
const MAX_ISSUING_SYSTEM = 200;

const noNegativeZero = (value: number) => (value === 0 ? 0 : value);

function at(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let current = node;
  for (const name of path) current = current && firstChild(current, name);
  return current;
}

function text(node: XmlNode | undefined, ...path: string[]): string {
  return at(node, ...path)?.text.trim() ?? "";
}

function required(node: XmlNode, ...path: string[]): XmlNode {
  const found = at(node, ...path);
  if (!found) throw new IsdocInvalid(`Chybí element ${path.join("/")}`);
  return found;
}

function decimal(node: XmlNode, name: string, scale: number): number {
  const value = required(node, name).text.trim();
  try {
    return decimalToMinor(value, scale);
  } catch (error) {
    if (error instanceof InputRejected) throw new IsdocInvalid(`Neplatné číslo v elementu ${name}`);
    throw error;
  }
}

function date(value: string, name: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  const parsed =
    match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    !match ||
    !parsed ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCMonth() !== Number(match[2]) - 1
  ) {
    throw new IsdocInvalid(`Neplatné datum v elementu ${name}`);
  }
  return `${match[1]}-${match[2]}-${match[3]}` as CalendarDate;
}

function optionalDate(node: XmlNode | undefined, ...path: string[]): CalendarDate | null {
  const value = text(node, ...path);
  return value ? date(value, path.join("/")) : null;
}

function party(node: XmlNode): ImportParty {
  const p = required(node, "Party");
  const schemes = children(p, "PartyTaxScheme");
  const vat = schemes.find((s) => text(s, "TaxScheme").toUpperCase() === "VAT") ?? schemes[0];
  const countryName = text(p, "PostalAddress", "Country", "Name");
  const countryCode = text(p, "PostalAddress", "Country", "IdentificationCode");
  const country =
    countryCode.toUpperCase() === "CZ"
      ? DOMESTIC_COUNTRY
      : canonicalCountry(countryName || importedCountry(countryCode));
  const street = [
    text(p, "PostalAddress", "StreetName"),
    text(p, "PostalAddress", "BuildingNumber"),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    name: text(p, "PartyName", "Name"),
    street,
    city: text(p, "PostalAddress", "CityName"),
    zip: text(p, "PostalAddress", "PostalZone"),
    country,
    ico: text(p, "PartyIdentification", "ID").replace(/\s+/g, ""),
    dic: text(vat, "CompanyID").replace(/\s+/g, ""),
    email: text(p, "Contact", "ElectronicMail"),
    phone: text(p, "Contact", "Telephone"),
  };
}

// Half away from zero, like every other conversion of money in the app.
function rateMicros(root: XmlNode): number | null {
  const curr = text(root, "CurrRate");
  const ref = text(root, "RefCurrRate");
  if (!curr || !ref) return null;
  let quoted: bigint;
  let unit: bigint;
  try {
    quoted = BigInt(decimalToMicros(curr));
    unit = BigInt(decimalToMicros(ref));
  } catch {
    return null;
  }
  if (quoted <= BigInt(0) || unit <= BigInt(0)) return null;
  const micros = (TWO * quoted * RATE_UNIT + unit) / (TWO * unit);
  if (micros > MAX_RATE || micros <= BigInt(0)) {
    throw new IsdocInvalid("Kurz v CurrRate a RefCurrRate je mimo rozsah");
  }
  return micros === RATE_UNIT ? null : Number(micros);
}

export function parseIsdoc(bytes: Uint8Array): ImportDocument {
  return isdocFromXml(parseXml(bytes, XML_LIMITS));
}

export function isdocFromXml(root: XmlNode): ImportDocument {
  if (root.name !== "Invoice" || root.ns !== ISDOC_NAMESPACE) {
    throw new IsdocInvalid("Soubor není faktura ISDOC");
  }
  const version = root.attributes.version ?? "";
  if (!(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
    throw new IsdocInvalid(
      `Verze ISDOC ${version.slice(0, 20) || "bez označení"} není podporovaná`,
    );
  }
  const sourceType = text(root, "DocumentType");
  if (!(sourceType in TYPES)) throw new IsdocInvalid("Neznámý typ dokladu");
  const type = TYPES[sourceType]!;
  const sign = type === "credit_note" ? -1 : 1;

  const localCurrency = text(root, "LocalCurrencyCode").toUpperCase();
  const foreignCode = text(root, "ForeignCurrencyCode").toUpperCase();
  const foreign = foreignCode !== "" && foreignCode !== localCurrency;
  const currency = foreign ? foreignCode : localCurrency;
  if (!/^[A-Z]{3}$/.test(currency)) throw new IsdocInvalid("Neplatný kód měny");
  // Domestic amounts are a conversion; in a foreign currency only the *Curr ones are the document.
  const money = (node: XmlNode, name: string) =>
    noNegativeZero(sign * decimal(node, foreign ? `${name}Curr` : name, 2));

  const lines: ImportLine[] = children(required(root, "InvoiceLines"), "InvoiceLine").map(
    (line) => {
      const quantityText = text(line, "InvoicedQuantity");
      let quantity = 1000;
      if (quantityText) {
        try {
          quantity = quantityToMilli(quantityText);
        } catch {
          throw new IsdocInvalid("Neplatné číslo v elementu InvoicedQuantity");
        }
      }
      const direction = quantity < 0 ? -1 : 1;
      const quantityMilli = Math.abs(quantity);
      // The amount carries its own sign; only the unit price takes it from the quantity.
      const netMinor = money(line, "LineExtensionAmountTaxInclusive");
      let unitPriceMinor = 0;
      if (!foreign) {
        unitPriceMinor = noNegativeZero(
          direction * sign * decimal(line, "UnitPriceTaxInclusive", 2),
        );
      } else if (quantityMilli > 0) {
        unitPriceMinor =
          Math.sign(netMinor) * Math.round((Math.abs(netMinor) * 1000) / quantityMilli);
      }
      const item = text(line, "Item", "Description");
      const note = text(line, "Note");
      return {
        name: item || note || "Položka",
        description: item ? note : "",
        quantityMilli,
        unit: at(line, "InvoicedQuantity")?.attributes.unitCode?.trim() ?? "",
        unitPriceMinor,
        netMinor,
      };
    },
  );
  if (lines.length === 0) throw new IsdocInvalid("Doklad nemá žádnou položku");

  const totals = required(root, "LegalMonetaryTotal");
  const rounding = at(totals, foreign ? "PayableRoundingAmountCurr" : "PayableRoundingAmount")
    ? money(totals, "PayableRoundingAmount")
    : 0;
  const totalMinor = money(totals, "TaxInclusiveAmount") + rounding;
  const subtotalMinor = lines.reduce((sum, line) => sum + line.netMinor, 0);

  const payments = children(at(root, "PaymentMeans") ?? root, "Payment");
  const chosen =
    payments.find((p) => text(at(p, "Details"), "PaymentDueDate")) ??
    payments.find((p) => at(p, "Details")) ??
    payments[0];
  const details = chosen && at(chosen, "Details");
  const paymentMeansCode = chosen ? text(chosen, "PaymentMeansCode") : "";

  const account: ImportAccount = {
    number: text(details, "ID"),
    bankCode: text(details, "BankCode"),
    iban: text(details, "IBAN").replace(/\s+/g, ""),
    swift: text(details, "BIC"),
  };

  const references = at(root, "OriginalDocumentReferences");
  const originalDocuments: ImportReference[] = references
    ? children(references, "OriginalDocumentReference").map((ref) => ({
        number: text(ref, "ID"),
        uuid: text(ref, "UUID").toLowerCase() || null,
        issueDate: optionalDate(ref, "IssueDate"),
      }))
    : [];
  const depositList = at(root, "NonTaxedDeposits");
  const deposits: ImportDeposit[] = depositList
    ? children(depositList, "NonTaxedDeposit").map((deposit) => ({
        number: text(deposit, "ID"),
        variableSymbol: text(deposit, "VariableSymbol"),
        amountMinor: decimal(deposit, foreign ? "DepositAmountCurr" : "DepositAmount", 2),
      }))
    : [];

  const uuid = text(root, "UUID").toLowerCase();
  const customer = at(root, "AccountingCustomerParty");
  const issuingSystem = text(root, "IssuingSystem").slice(0, MAX_ISSUING_SYSTEM);

  return {
    type,
    sourceType,
    isdocVersion: version,
    number: required(root, "ID").text.trim(),
    uuid: UUID.test(uuid) ? uuid : null,
    issueDate: date(text(root, "IssueDate"), "IssueDate"),
    taxableDate: optionalDate(root, "TaxPointDate"),
    dueDate: optionalDate(details, "PaymentDueDate"),
    supplier: party(required(root, "AccountingSupplierParty")),
    customer: customer ? party(customer) : null,
    lines,
    currency,
    exchangeRateMicros: foreign ? rateMicros(root) : null,
    subtotalMinor,
    roundingMinor: totalMinor - subtotalMinor,
    totalMinor,
    payableMinor: money(totals, "PayableAmount"),
    paidDepositsMinor: money(totals, "PaidDepositsAmount"),
    variableSymbol: text(details, "VariableSymbol") || null,
    account: Object.values(account).some(Boolean) ? account : null,
    paymentMeansCode: PAYMENT_MEANS_CODES.has(paymentMeansCode) ? paymentMeansCode : null,
    originalDocuments,
    deposits,
    vatApplicable: text(root, "VATApplicable") === "true",
    note: text(root, "Note"),
    issuingSystem: issuingSystem || null,
  };
}
