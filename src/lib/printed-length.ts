// The PDF text budget, shared by the PDF gate (services/invoice-pdf.ts) and the form
// (checkDocumentSize), so the form never accepts a document that has no PDF. react-pdf renders
// synchronously and its cost grows with the text: 159 000 characters took 11 s and +329 MiB RSS
// here (PDF-005 test), so the budget keeps a render near 0.4 GiB. Renders are serialized
// (serializeRender), so they do not add up.
export const PDF_TEXT_BUDGET = 200_000;

// What a document adds to its lines and texts when it is printed: the frozen supplier (about
// 4 100 characters at most), customer (900) and account (180), number, dates and the header.
export const DOCUMENT_FRAME_CHARS = 10_000;

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
