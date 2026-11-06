import { z } from "zod";
import type { ImportDocument } from "./import-document";
import type { TabularSample } from "./import-mapping";
import { isCalendarDate, type CalendarDate } from "./number-format";

export const MAX_BATCH_DOCUMENTS = 5000;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type PreviewStatus = "ok" | "warning" | "error" | "duplicate" | "skipped";

export type CustomerAction =
  | { kind: "existing"; customerId: string; name: string }
  | { kind: "create"; key: string; name: string }
  | { kind: "choose"; options: { id: string; name: string; archived: boolean }[] }
  | { kind: "none" };

// Where a credit note's original or a final invoice's advance lives: earlier in the batch or in
// the account already.
export type PreviewLink = { kind: "batch"; key: string } | { kind: "account"; id: string };

export type PreviewRow = {
  key: string;
  source: string;
  document: ImportDocument | null;
  status: PreviewStatus;
  // What the row was before the user skipped it, so a skip can be taken back.
  skippedFrom: PreviewStatus | null;
  messages: string[];
  customerAction: CustomerAction;
  paidOn: CalendarDate | null;
  paidMinor: number;
  dateEstimated: boolean;
  // R-10: a supplier without an IČO on one side is the user's word that the document is theirs.
  ownConfirmed: boolean | null;
  original: PreviewLink | null;
  advance: PreviewLink | null;
  pdfFileId: string | null;
  // A customer or a catalog item from a table: the raw input, checked again by its schema on commit.
  record?: PreviewRecord;
};

export type PreviewRecord = {
  target: "customers" | "catalog";
  input: Record<string, unknown>;
  name: string;
  detail: string;
};

// The sample of a table stays next to the rows, so the mapping can be changed from the preview.
export type Preview = { rows: PreviewRow[]; sample?: TabularSample };

export function rowBlocks(row: PreviewRow): boolean {
  if (row.status === "skipped" || row.status === "duplicate") return false;
  if (row.status === "error") return true;
  if (row.ownConfirmed === false) return true;
  return row.customerAction.kind === "choose";
}

export function importsRow(row: PreviewRow): boolean {
  return row.status === "ok" || row.status === "warning";
}

const keys = z.array(z.string().min(1).max(64)).min(1).max(MAX_BATCH_DOCUMENTS);
const date = z.string().refine(isCalendarDate, "Neplatné datum");

export const previewChangeSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("skip"), keys, skip: z.boolean() }),
    z.strictObject({
      kind: z.literal("paidOn"),
      keys,
      mode: z.enum(["date", "due", "issue"]),
      date: date.optional(),
    }),
    z.strictObject({ kind: z.literal("confirmOwn"), keys }),
    z.strictObject({
      kind: z.literal("customer"),
      keys,
      customerId: z.string().min(1).max(64).nullable(),
    }),
  ],
  "Neplatná změna náhledu",
);

export type PreviewChange = z.input<typeof previewChangeSchema>;
