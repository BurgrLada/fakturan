import type { Language } from "./preferences";

// The wording is not verified by a tax adviser yet, see chapter 24 of the spec.
export const REVERSE_CHARGE_CLAUSE: Record<Language, string> = {
  cs: "Daň odvede zákazník (přenesení daňové povinnosti, čl. 196 směrnice 2006/112/ES).",
  en: "Reverse charge: VAT to be accounted for by the customer (Article 196 of Directive 2006/112/EC).",
};

// Without CZ: a Czech customer is a domestic supply. Greece uses EL in VAT IDs.
export const EU_COUNTRY_CODES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;

const EU_CODES: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);

export function splitVatId(dic: string): { country: string; number: string } | null {
  const compact = dic.replace(/\s+/g, "").toUpperCase();
  const match = /^([A-Z]{2})([A-Z0-9]{2,14})$/.exec(compact);
  return match ? { country: match[1]!, number: match[2]! } : null;
}

export function isEuVatId(dic: string): boolean {
  const parts = splitVatId(dic);
  return parts !== null && EU_CODES.has(parts.country);
}

export function suggestedClause(input: {
  foreign: boolean;
  language: Language;
  vatIdentified: boolean;
  customerDic: string;
  texts: Record<Language, string>;
}): string {
  const applies = input.foreign && input.vatIdentified && isEuVatId(input.customerDic);
  return applies ? input.texts[input.language] : "";
}
