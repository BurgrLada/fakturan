export const DOMESTIC_COUNTRY = "Česká republika";

const DOMESTIC_ALIASES = new Set(
  ["", DOMESTIC_COUNTRY, "Česko", "Czechia", "Czech Republic", "CZ"].map((v) => v.toLowerCase()),
);

export function isDomesticCountry(country: string): boolean {
  return DOMESTIC_ALIASES.has(country.trim().toLowerCase());
}

export function canonicalCountry(country: string): string {
  const trimmed = country.trim();
  return isDomesticCountry(trimmed) && trimmed !== "" ? DOMESTIC_COUNTRY : trimmed;
}

export const CUSTOMER_STATUSES = ["active", "archived", "all"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
