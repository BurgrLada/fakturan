import type { Currency } from "./currency";

// Every supported currency has two minor digits; money.test.ts asserts it.
const AMOUNT = /^(-?)(\d{1,3}(?:[ \u00A0\u202F]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/;

// Returns minor units, or null when the text is not an amount a person would write.
export function parseMoney(input: string): number | null {
  const match = AMOUNT.exec(input.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents =
    Number(whole.replace(/[ \u00A0\u202F]/g, "")) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return sign && cents !== 0 ? -cents : cents;
}

const FORMATTERS = new Map<Currency, Intl.NumberFormat>();

export function formatMoney(cents: number, currency: Currency): string {
  let formatter = FORMATTERS.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("cs-CZ", { style: "currency", currency });
    FORMATTERS.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

// Plain form-field notation: no grouping, decimal comma.
export function formatMoneyInput(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole},${fraction}`;
}
