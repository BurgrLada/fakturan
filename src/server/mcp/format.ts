import { z } from "zod";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";

// Shared by the tools: the money shape (ARC-002), links into the web app and the fence around text
// that came from a document (MCP-033).

export type Money = { amount: number; currency: string; formatted: string };

export const moneySchema = z.object({
  amount: z.number().int(),
  currency: z.string(),
  formatted: z.string(),
});

// Whole minor units plus the currency, and the same amount written the way the web shows it.
export function money(minor: number, currency: string): Money {
  const known = (CURRENCIES as readonly string[]).includes(currency);
  return {
    amount: minor,
    currency,
    formatted: known
      ? formatMoney(minor, currency as Currency)
      : `${(minor / 100).toFixed(2).replace(".", ",")} ${currency}`,
  };
}

// An absolute address of a page of the web app; the origin comes from BETTER_AUTH_URL.
export function appLink(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const MAX_QUOTED_CHARS = 500;
const LINE_BREAKS = /[\t\r\n\u0085\u2028\u2029]+/gu;
// Control characters and invisible format characters (bidi overrides, zero width joiners).
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

// A value from a document, fenced as «label: value» on one line so the model reads it as data and
// not as part of the sentence around it. The value cannot close the fence early.
export function quoted(label: string, value: string): string {
  const clean = value
    .replace(LINE_BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/[«»]/gu, (mark) => (mark === "«" ? "‹" : "›"))
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(`${label.replace(/[«»\p{Cc}\p{Cf}]/gu, "")}: ${clean}`);
  // The two marks count toward the limit.
  const room = MAX_QUOTED_CHARS - 2;
  const body = chars.length > room ? `${chars.slice(0, room - 1).join("")}…` : chars.join("");
  return `«${body}»`;
}

// "1" for 1000, "0,5" for 500: quantities are kept in thousandths.
export function quantityText(milli: number): string {
  return (milli / 1000).toLocaleString("cs-CZ", { maximumFractionDigits: 3 });
}
