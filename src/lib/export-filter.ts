import { z } from "zod";
import { INVOICE_STATUSES, INVOICE_TYPES, MAX_BULK_DOCUMENTS } from "./invoice";
import { isCalendarDate, type CalendarDate } from "./number-format";
import { TEXTS } from "./texts";

const E = TEXTS.exporting.errors;

export const EXPORT_KINDS = ["invoices", "customers", "catalog", "payments", "templates"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_FORMATS = ["pdf_zip", "isdoc_zip", "csv", "xlsx", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// Templates are JSON only: they come back solely through a backup (R-23).
export const FORMATS_BY_KIND: Record<ExportKind, readonly ExportFormat[]> = {
  invoices: ["pdf_zip", "isdoc_zip", "csv", "xlsx"],
  customers: ["csv", "xlsx"],
  catalog: ["csv", "xlsx"],
  payments: ["csv", "xlsx"],
  templates: ["json"],
};

// A draft is never exported, so it is no status to filter by.
export const EXPORT_INVOICE_STATUSES = INVOICE_STATUSES.filter((status) => status !== "draft");
type ExportInvoiceStatus = (typeof EXPORT_INVOICE_STATUSES)[number];

const date = z
  .string(E.invalid)
  .refine(isCalendarDate, E.date)
  .transform((value) => value as CalendarDate);
const id = z.string(E.invalid).min(1, E.invalid).max(64, E.invalid);

const filterSchema = z.strictObject({
  from: date.optional(),
  to: date.optional(),
  types: z.array(z.enum(INVOICE_TYPES, E.invalid)).max(INVOICE_TYPES.length).optional(),
  customerId: id.optional(),
  statuses: z
    .array(z.enum(EXPORT_INVOICE_STATUSES as [ExportInvoiceStatus], E.invalid))
    .max(EXPORT_INVOICE_STATUSES.length)
    .optional(),
  ids: z
    .array(id)
    .min(1, E.invalid)
    .max(MAX_BULK_DOCUMENTS, E.tooMany(MAX_BULK_DOCUMENTS))
    .optional(),
});

export type ExportFilter = z.output<typeof filterSchema>;

// Which filter fields each kind understands: anything else would be silently ignored.
const ALLOWED_FILTERS: Record<ExportKind, readonly (keyof ExportFilter)[]> = {
  invoices: ["from", "to", "types", "customerId", "statuses", "ids"],
  payments: ["from", "to"],
  customers: [],
  catalog: [],
  templates: [],
};

export const exportInputSchema = z
  .strictObject({
    kind: z.enum(EXPORT_KINDS, E.invalid),
    format: z.enum(EXPORT_FORMATS, E.invalid),
    filter: filterSchema.default({}),
  })
  .superRefine((input, ctx) => {
    if (!FORMATS_BY_KIND[input.kind].includes(input.format)) {
      ctx.addIssue({ code: "custom", message: E.format, path: ["format"] });
    }
    const allowed = ALLOWED_FILTERS[input.kind];
    for (const key of Object.keys(input.filter) as (keyof ExportFilter)[]) {
      if (input.filter[key] !== undefined && !allowed.includes(key)) {
        ctx.addIssue({ code: "custom", message: E.filter, path: ["filter", key] });
      }
    }
    const { from, to } = input.filter;
    if (from && to && from > to) {
      ctx.addIssue({ code: "custom", message: E.period, path: ["filter", "to"] });
    }
  });

export type ExportInput = z.input<typeof exportInputSchema>;
export type ParsedExportInput = z.output<typeof exportInputSchema>;

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  pdf_zip: "zip",
  isdoc_zip: "zip",
  csv: "csv",
  xlsx: "xlsx",
  json: "json",
};

export const EXPORT_MIME_TYPES: Record<ExportFormat, string> = {
  pdf_zip: "application/zip",
  isdoc_zip: "application/zip",
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
};

export function exportFileName(kind: ExportKind, format: ExportFormat, day: CalendarDate): string {
  const stem = format === "isdoc_zip" ? "faktury-isdoc" : TEXTS.exporting.fileStems[kind];
  return `${stem}-${day}.${EXPORT_EXTENSIONS[format]}`;
}

// What the person gets, said before they start it: an invoice CSV has no lines, the Excel has.
export function exportContents(kind: ExportKind, format: ExportFormat): string {
  const C = TEXTS.exporting.contents;
  if (kind === "invoices") return C.invoices[format as keyof typeof C.invoices] ?? "";
  return C[kind];
}
