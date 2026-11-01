import type { InvoiceDocument } from "@/lib/invoice-document";
import { LABELS } from "./labels";

const MAX_NAME_CHARS = 120;
const UNSAFE_NAME_CHARS = /[\\/"<>:|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function fileNameFor(
  template: string,
  doc: Pick<InvoiceDocument, "number" | "customerName" | "language">,
): string {
  const labels = LABELS[doc.language];
  const number = doc.number ?? labels.draft.toLocaleLowerCase(labels.locale);
  const stem = template
    .replace(/\{cislo\}/g, () => number)
    .replace(/\{zakaznik\}/g, () => doc.customerName)
    .toWellFormed()
    .replace(/\.pdf$/i, "")
    .replace(UNSAFE_NAME_CHARS, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const bounded = Array.from(stem).slice(0, MAX_NAME_CHARS).join("");
  return `${bounded || labels.documentTypes.invoice.toLocaleLowerCase(labels.locale)}.pdf`;
}
