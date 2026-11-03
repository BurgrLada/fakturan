import { decimalToMinor } from "@/lib/safe-input/decimal";
import { ISDOC_NAMESPACE } from "@/lib/safe-input/pdf-embedded";
import { children, firstChild, type XmlNode } from "@/lib/safe-input/xml";

// Elements that have a *Curr twin in the 6.0.x schema; a foreign-currency document needs every twin.
const WITH_CURR = new Set([
  "LineExtensionAmount",
  "LineExtensionAmountTaxInclusive",
  "DepositAmount",
  "TaxableDepositAmount",
  "TaxInclusiveDepositAmount",
  "TaxableAmount",
  "TaxAmount",
  "TaxInclusiveAmount",
  "AlreadyClaimedTaxableAmount",
  "AlreadyClaimedTaxAmount",
  "AlreadyClaimedTaxInclusiveAmount",
  "DifferenceTaxableAmount",
  "DifferenceTaxAmount",
  "DifferenceTaxInclusiveAmount",
  "TaxExclusiveAmount",
  "AlreadyClaimedTaxExclusiveAmount",
  "DifferenceTaxExclusiveAmount",
  "PayableRoundingAmount",
  "PaidDepositsAmount",
  "PayableAmount",
]);
const AMOUNT_PARENTS = new Set([
  "InvoiceLine",
  "NonTaxedDeposit",
  "TaxedDeposit",
  "TaxSubTotal",
  "TaxTotal",
  "LegalMonetaryTotal",
]);
const NEEDS_ORIGINAL = new Set(["2", "3", "6"]);
// Sums are compared at four decimals, so lines priced to the haléř and beyond add up exactly.
const SCALE = 4;
const ONE_UNIT = 10 ** SCALE;

const label = (minor: number) => (minor / ONE_UNIT).toFixed(SCALE).replace(/0{1,2}$/, "");

function amount(node: XmlNode | undefined, name: string): number | null {
  const value = node && firstChild(node, name)?.text.trim();
  if (!value) return null;
  try {
    return decimalToMinor(value, SCALE);
  } catch {
    return null;
  }
}

function missingCurr(node: XmlNode, missing: Set<string>): void {
  if (AMOUNT_PARENTS.has(node.name)) {
    for (const child of node.children) {
      if (WITH_CURR.has(child.name) && !firstChild(node, `${child.name}Curr`))
        missing.add(child.name);
    }
  }
  for (const child of node.children) missingCurr(child, missing);
}

function checkSums(root: XmlNode, suffix: "" | "Curr", tolerance: number): string[] {
  const errors: string[] = [];
  const where = suffix ? " (cizí měna)" : "";
  const total = firstChild(root, "LegalMonetaryTotal");
  const lines = children(firstChild(root, "InvoiceLines") ?? root, "InvoiceLine");
  const sum = (nodes: XmlNode[], name: string) =>
    nodes.reduce((acc, node) => acc + (amount(node, name + suffix) ?? 0), 0);
  const check = (actual: number | null, expected: number, allowed: number, what: string) => {
    if (actual !== null && Math.abs(actual - expected) > allowed) {
      errors.push(`${what}${where}: ${label(actual)} místo ${label(expected)}`);
    }
  };

  const exclusive = amount(total, `TaxExclusiveAmount${suffix}`);
  const inclusive = amount(total, `TaxInclusiveAmount${suffix}`);
  check(
    exclusive,
    sum(lines, "LineExtensionAmount"),
    ONE_UNIT,
    "Celek bez daně nesedí se součtem řádků",
  );
  check(
    inclusive,
    sum(lines, "LineExtensionAmountTaxInclusive"),
    ONE_UNIT,
    "Celek s daní nesedí se součtem řádků",
  );

  const taxTotal = firstChild(root, "TaxTotal");
  const subTotals = taxTotal ? children(taxTotal, "TaxSubTotal") : [];
  check(
    inclusive,
    sum(subTotals, "TaxInclusiveAmount"),
    tolerance,
    "Celek s daní nesedí s rekapitulací daně",
  );

  // Difference* and the TaxTotal sum are left out: issuing systems fill them inconsistently, and
  // the app takes neither.
  const payable = amount(total, `PayableAmount${suffix}`);
  const claimed = amount(total, `AlreadyClaimedTaxInclusiveAmount${suffix}`) ?? 0;
  const rounding = amount(total, `PayableRoundingAmount${suffix}`) ?? 0;
  const deposits = amount(total, `PaidDepositsAmount${suffix}`) ?? 0;
  if (payable !== null && inclusive !== null) {
    const ceiling = inclusive - claimed + rounding - deposits;
    if (payable < 0 || payable > Math.max(0, ceiling) + tolerance) {
      errors.push(
        `K úhradě${where} ${label(payable)} je mimo rozsah 0 až ${label(Math.max(0, ceiling))}`,
      );
    }
  }
  return errors;
}

// The schematron needs XSLT 2, so the rules the app depends on are checked by hand (R-3).
export function isdocRules(xml: XmlNode): string[] {
  if (xml.name !== "Invoice" || xml.ns !== ISDOC_NAMESPACE) return ["Soubor není faktura ISDOC"];
  const errors: string[] = [];
  const type = firstChild(xml, "DocumentType")?.text.trim() ?? "";
  const references = firstChild(xml, "OriginalDocumentReferences");
  if (
    NEEDS_ORIGINAL.has(type) &&
    !(references && children(references, "OriginalDocumentReference").length > 0)
  ) {
    errors.push(`Doklad typu ${type} nemá odkaz na původní doklad`);
  }

  const local = firstChild(xml, "LocalCurrencyCode")?.text.trim() ?? "";
  const foreignCode = firstChild(xml, "ForeignCurrencyCode")?.text.trim() ?? "";
  const foreign = foreignCode !== "" && foreignCode !== local;
  if (foreign) {
    const missing = new Set<string>();
    missingCurr(xml, missing);
    for (const name of missing) errors.push(`V cizí měně chybí ${name}Curr`);
    errors.push(...checkSums(xml, "Curr", 0));
  }
  // Domestic amounts of a foreign-currency document are conversions and may round apart.
  errors.push(...checkSums(xml, "", foreign ? ONE_UNIT : 0));
  return errors;
}
