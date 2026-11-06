import "server-only";
import { zipSync, type Zippable } from "fflate";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { fileNameFor } from "../pdf/file-name";
import { renderInvoicePdf } from "../pdf/render";
import { buildInvoiceView } from "../pdf/view";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, InvoicePdfNotFoundError, PdfTooLong, ServiceError } from "./access";
import { FileNotFoundError, readOwnedFile } from "./files";
import { loadInvoiceDocument } from "./invoice-document";
import { getVersion } from "./invoice-versions";
import { getInvoice, ownerOf } from "./invoices";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

export { InvoicePdfNotFoundError };

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

// react-pdf renders synchronously and its cost grows with the text. The longest document the form
// accepts prints about 159 000 characters and took 11 s and +329 MiB RSS here (PDF-005 test). The
// budget leaves it room, keeps a render near 0.4 GiB and stops the hostile or pre-cap documents
// that would need gigabytes. Renders are serialized (serializeRender), so they do not add up.
export const PDF_TEXT_BUDGET = 200_000;

// Every string the document carries, which bounds what the page shows: lines, texts, snapshots.
export function printedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value))
    return value.reduce((sum: number, item) => sum + printedLength(item), 0);
  if (value !== null && typeof value === "object") {
    let sum = 0;
    for (const item of Object.values(value)) sum += printedLength(item);
    return sum;
  }
  return 0;
}

// One gate for every PDF of a document: the invoice, a version, a sent message and an export.
export async function documentPdf(
  ownerId: string,
  doc: InvoiceDocument,
): Promise<{ data: Buffer; fileName: string }> {
  if (printedLength(doc) > PDF_TEXT_BUDGET) throw new PdfTooLong(TEXTS.pdf.tooLong);
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

export async function invoicePdf(ownerId: string, id: string) {
  const doc = loadInvoiceDocument(ownerId, id);
  if (!doc) throw new InvoicePdfNotFoundError();
  return documentPdf(ownerId, doc);
}

// A version is rendered from its own stored document, so it shows what the document said back then.
export async function versionPdf(ownerId: string, invoiceId: string, versionId: string) {
  const version = getVersion(ownerId, versionId);
  if (version?.invoiceId !== invoiceId) throw new InvoicePdfNotFoundError();
  return documentPdf(ownerId, version.document);
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
// The number goes before the extension, whichever it is.
export function fileNameTaker(): (name: string) => string {
  const taken = new Set<string>();
  return (name) => {
    const extension = /\.[^.\s]{1,8}$/.exec(name)?.[0] ?? "";
    const stem = name.slice(0, name.length - extension.length);
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLocaleLowerCase("cs")); n += 1) {
      candidate = `${stem} (${n})${extension}`;
    }
    taken.add(candidate.toLocaleLowerCase("cs"));
    return candidate;
  };
}

export function uniqueFileNames(names: string[]): string[] {
  const take = fileNameTaker();
  return names.map((name) => take(name));
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
