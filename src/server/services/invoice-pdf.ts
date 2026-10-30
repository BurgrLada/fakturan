import "server-only";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { calendarDateInPrague } from "@/lib/number-format";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { LABELS } from "../pdf/labels";
import { renderInvoicePdf } from "../pdf/render";
import { buildInvoiceView } from "../pdf/view";
import { FileNotFoundError, readOwnedFile } from "./files";
import { loadInvoiceDocument } from "./invoice-document";
import { getInvoice } from "./invoices";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

export class InvoicePdfNotFoundError extends Error {}

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

function ownerImageReader(ownerId: string) {
  const actor: Actor = { userId: ownerId, source: "system" };
  return (fileId: string): Buffer | null => {
    try {
      return readOwnedFile(actor, fileId).data;
    } catch (error) {
      if (error instanceof FileNotFoundError) return null;
      throw error;
    }
  };
}

export async function invoicePdf(
  ownerId: string,
  id: string,
): Promise<{ data: Buffer; fileName: string }> {
  const doc = loadInvoiceDocument(ownerId, id);
  if (!doc) throw new InvoicePdfNotFoundError();
  const view = await buildInvoiceView(doc, {
    today: calendarDateInPrague(clock.now()),
    draft: doc.status === "draft",
    readImage: ownerImageReader(ownerId),
  });
  return {
    data: await renderInvoicePdf(view),
    fileName: fileNameFor(getPreferences(ownerId).pdfFileName, doc),
  };
}

export function recordPdfDownload(actor: Actor, ownerId: string, id: string): void {
  const row = getInvoice(ownerId, id);
  if (!row || row.status === "draft") return;
  mutate(actor, "invoice.pdf_download", (_tx, audit) =>
    audit({
      entity: "invoice",
      entityId: id,
      ownerId,
      scope: "user",
      after: { number: row.number },
    }),
  );
}
