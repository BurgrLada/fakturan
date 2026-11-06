import type { TaxLine } from "@/server/reports/tax";
import type { Unconverted } from "@/server/reports/types";
import { formatMoney } from "./money";
import { TEXTS } from "./texts";

const T = TEXTS.tax;

// R-29: the texts are a draft until a tax adviser confirms them; the page shows a label meanwhile.
export const TAX_TEXT_REVIEWED = false;

// One wording for the page, the PDF and the sheets, so the outputs cannot drift apart.
export function lineNote(line: Pick<TaxLine, "estimated" | "related">): string {
  const parts: string[] = [];
  if (line.related?.role === "final") {
    parts.push(line.related.number ? T.advanceOf(line.related.number) : T.advanceNoFinal);
  } else if (line.related?.role === "advance" && line.related.number) {
    parts.push(T.finalOf(line.related.number));
  }
  if (line.estimated) parts.push(T.estimatedMark);
  return parts.join(", ");
}

export function unconvertedText(unconverted: Unconverted): string | null {
  if (unconverted.count === 0) return null;
  const amounts = unconverted.byCurrency
    .map(({ currency, amountMinor }) => formatMoney(amountMinor, currency))
    .join(", ");
  return T.unconverted(unconverted.count, amounts);
}
