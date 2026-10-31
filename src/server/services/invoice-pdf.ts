import "server-only";
import { zipSync, type Zippable } from "fflate";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { LABELS } from "../pdf/labels";
import { renderInvoicePdf } from "../pdf/render";
import { buildInvoiceView } from "../pdf/view";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, ServiceError } from "./access";
import { FileNotFoundError, readOwnedFile } from "./files";
import { loadInvoiceDocument } from "./invoice-document";
import { getInvoice, ownerOf } from "./invoices";
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

export function ownerImageReader(ownerId: string) {
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

// Compared without case, because archives are often unpacked on case-insensitive file systems.
export function uniqueFileNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const stem = name.replace(/\.pdf$/i, "");
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLocaleLowerCase("cs")); n += 1) {
      candidate = `${stem} (${n}).pdf`;
    }
    taken.add(candidate.toLocaleLowerCase("cs"));
    return candidate;
  });
}

export async function invoicesZip(
  actor: Actor,
  ids: string[],
): Promise<{ data: Uint8Array<ArrayBuffer>; fileName: string }> {
  const ownerId = ownerOf(actor);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_DOCUMENTS) {
    throw new ServiceError(TEXTS.invoices.list.bulk.tooMany(MAX_BULK_DOCUMENTS));
  }
  for (const id of unique) {
    const row = getInvoice(ownerId, id);
    if (!row || row.status === "draft") throw new InvoicePdfNotFoundError();
  }
  enforceRateLimit(actor, RATE_RULES.exportUser);

  // One at a time: rendering is CPU heavy and would otherwise block every other request.
  const pdfs: Awaited<ReturnType<typeof invoicePdf>>[] = [];
  for (const id of unique) pdfs.push(await invoicePdf(ownerId, id));
  for (const id of unique) recordPdfDownload(actor, ownerId, id);

  const names = uniqueFileNames(pdfs.map((pdf) => pdf.fileName));
  const entries: Zippable = {};
  // PDF streams are already compressed.
  names.forEach((name, index) => {
    entries[name] = [new Uint8Array(pdfs[index]!.data), { level: 0 }];
  });
  return {
    data: new Uint8Array(zipSync(entries)),
    fileName: `faktury-${calendarDateInPrague(clock.now())}.zip`,
  };
}
