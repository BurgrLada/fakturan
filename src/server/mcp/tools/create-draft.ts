import { z } from "zod";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { MAX_DOCUMENT_LINES } from "@/lib/invoice";
import { DISCOUNT_KINDS, parseQuantity } from "@/lib/invoice-totals";
import { parseMoney } from "@/lib/money";
import { isCalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { getCatalogItem } from "../../services/catalog";
import { getCustomer } from "../../services/customers";
import { draftRate } from "../../services/exchange-rates";
import { checkIssuable } from "../../services/invoice-lifecycle";
import {
  getInvoice,
  MAX_DOCUMENT_TEXT,
  MAX_LINE_NAME,
  newDraftDefaults,
  saveDraftWithTags,
  type DraftInput,
  type InvoiceDetail,
} from "../../services/invoices";
import { getPreferences } from "../../services/preferences";

const T = TEXTS.mcp.create;

// Amounts arrive as the decimal text a person would type and are read by the web form's own parsers
// (MCP-043, ARC-002); the tool does no arithmetic of its own.
const isQuantity = (value: string) => parseQuantity(value) !== null;
const isPrice = (value: string) => (parseMoney(value) ?? -1) >= 0;
const date = (description: string) =>
  z.string().refine(isCalendarDate, T.date).describe(description).optional();

export const lineInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, T.nameRequired)
      .max(MAX_LINE_NAME)
      .describe(T.lineName)
      .optional(),
    quantity: z.string().refine(isQuantity, T.quantityInvalid).describe(T.quantity),
    unitPrice: z.string().refine(isPrice, T.unitPriceInvalid).describe(T.unitPrice).optional(),
    vatRate: z
      .number()
      .refine((rate) => rate === 0, T.vatRateInvalid)
      .describe(T.vatRate)
      .optional(),
    catalogItemId: z.string().min(1).max(100).describe(T.catalogItemId).optional(),
    // What get_invoice returns for a line, so a resent line keeps it (the service checks the limits).
    description: z.string().max(MAX_DOCUMENT_TEXT).describe(T.lineDescription).optional(),
    unit: z.string().max(20).describe(T.lineUnit).optional(),
    discountKind: z.enum(DISCOUNT_KINDS).describe(T.discountKind).optional(),
    discount: z.string().refine(isPrice, T.discountInvalid).describe(T.discount).optional(),
  })
  .superRefine((line, ctx) => {
    if (line.catalogItemId) return;
    if (line.name === undefined) {
      ctx.addIssue({ code: "custom", path: ["name"], message: T.nameRequired });
    }
    if (line.unitPrice === undefined) {
      ctx.addIssue({ code: "custom", path: ["unitPrice"], message: T.priceRequired });
    }
  });

type LineInput = z.infer<typeof lineInput>;

// The fields of the document an assistant states; update_draft_invoice takes the same (MCP-024).
export const documentInput = {
  customerId: z.string().min(1).max(100).describe(T.customerId),
  lines: z.array(lineInput).min(1, T.linesRequired).max(MAX_DOCUMENT_LINES).describe(T.lines),
  issueDate: date(T.issueDate),
  dueDate: date(T.dueDate),
  currency: z.enum(CURRENCIES).describe(T.currency).optional(),
  note: z.string().max(MAX_DOCUMENT_TEXT).describe(T.note).optional(),
  // The service checks the names, as for the web form.
  tags: z.array(z.string().max(100)).max(100).describe(T.tags).optional(),
};

const input = z.strictObject({
  ...documentInput,
  idempotency_key: z.uuid().describe(T.idempotencyKey).optional(),
});

export const draftOutput = z.object({
  id: z.string(),
  type: z.string(),
  // Send it back with update_draft_invoice (MCP-072).
  revision: z.number().int(),
  problems: z.array(z.object({ field: z.string(), message: z.string() })),
  customerName: z.string(),
  lines: z.array(z.object({ name: z.string(), total: moneySchema })),
  note: z.string(),
  tags: z.array(z.string()),
  total: moneySchema,
  link: z.string(),
});

export type DraftOutput = z.infer<typeof draftOutput>;

export function draftOutputOf(ctx: ToolContext, row: InvoiceDetail): DraftOutput {
  return {
    id: row.id,
    type: row.type,
    revision: row.revision,
    problems: checkIssuable(ctx.ownerId, row.id),
    customerName: row.customerName,
    lines: row.lines.map((line) => ({
      name: line.name,
      total: money(line.netMinor, row.currency),
    })),
    note: row.note,
    tags: row.tags.map((tag) => tag.name),
    total: money(row.totalMinor, row.currency),
    link: appLink(ctx.baseUrl, `/faktury/${row.id}/upravit`),
  };
}

export const draftOfId = (ctx: ToolContext, id: string) =>
  draftOutputOf(ctx, getInvoice(ctx.ownerId, id)!);

// What a draft tool answers: the headline, then the document; its texts are data (MCP-033).
export const draftText = (headline: string) => (o: DraftOutput) =>
  [
    headline,
    quoted(T.customer, o.customerName),
    ...o.lines.map((line, i) =>
      T.line(quoted(T.lineLabel(i + 1), line.name), line.total.formatted),
    ),
    ...(o.note ? [quoted(T.noteLabel, o.note)] : []),
    ...(o.tags.length > 0 ? [quoted(T.tagsLabel, o.tags.join(", "))] : []),
    T.total(o.total.formatted),
    T.revision(o.revision),
    ...(o.problems.length > 0
      ? [T.problems, ...o.problems.map((problem) => `- ${problem.message}`)]
      : []),
    T.link(o.link),
  ].join("\n");

// A line as the form makes it: a picked catalog item fills name, description, unit and price, and
// what the assistant states wins, as when a person edits the picked line.
export function lineOf(
  ownerId: string,
  line: LineInput,
  currency: Currency,
  defaultUnit: string,
): DraftInput["lines"][number] {
  const item = line.catalogItemId ? getCatalogItem(ownerId, line.catalogItemId) : null;
  // The web picker offers only the account's active items.
  if (line.catalogItemId && (!item || item.archivedAt)) {
    throw new McpToolError(T.catalogItemNotFound);
  }
  // The form only warns about a price in another currency; an assistant would not see that.
  if (item && line.unitPrice === undefined && item.currency !== currency) {
    throw new McpToolError(T.catalogCurrency(item.currency, currency));
  }
  return {
    catalogItemId: item?.id ?? null,
    name: line.name ?? item?.name ?? "",
    description: line.description ?? item?.description ?? "",
    quantityMilli: parseQuantity(line.quantity)!,
    unit: line.unit ?? item?.unit ?? defaultUnit,
    unitPriceMinor:
      line.unitPrice === undefined ? (item?.priceMinor ?? 0) : parseMoney(line.unitPrice)!,
    // As the form reads it: percent in basis points and an amount in minor units share parseMoney.
    discountKind: line.discountKind ?? "none",
    discountValue: line.discount === undefined ? 0 : parseMoney(line.discount)!,
  };
}

// A stored line as the edit form sends it back unchanged.
export const keptLine = (line: InvoiceDetail["lines"][number]): DraftInput["lines"][number] => ({
  catalogItemId: line.catalogItemId,
  name: line.name,
  description: line.description,
  quantityMilli: line.quantityMilli,
  unit: line.unit,
  unitPriceMinor: line.unitPriceMinor,
  discountKind: line.discountKind,
  discountValue: line.discountValue,
});

export const createDraftInvoiceTool = defineTool({
  name: T.name,
  title: T.title,
  description: T.description,
  level: "drafts",
  input,
  output: draftOutput,
  fieldLabels: T.fields,
  run: async (ctx, args) => {
    const { ownerId, actor } = ctx;
    const key = args.idempotency_key;
    // A repeated call answers with the draft the first one made, whatever happened to it since. A key
    // another account holds is not seen here and makes saveDraft refuse; so does an own row that is
    // not an invoice draft (an issued invoice, an advance), which is never echoed or edited (MCP-043).
    const earlier = key ? getInvoice(ownerId, key) : null;
    if (earlier) {
      // saveDraft would treat an own row as an edit of it, so refuse here, as for a foreign key.
      if (earlier.type !== "invoice" || earlier.status !== "draft") {
        throw new McpToolError(TEXTS.invoices.validation.notFound);
      }
      return draftOutputOf(ctx, earlier);
    }

    // The web picker offers only the account's active customers; another account's looks missing.
    const customer = getCustomer(ownerId, args.customerId);
    if (!customer || customer.archivedAt) throw new McpToolError(TEXTS.mcp.read.customerNotFound);
    const base = newDraftDefaults(ownerId, customer.id, "invoice", {
      issueDate: args.issueDate,
      currency: args.currency,
    });
    const unit = getPreferences(ownerId).unit;
    const lines = args.lines.map((line) => lineOf(ownerId, line, base.currency, unit));
    const rate = await draftRate(actor, {
      currency: base.currency,
      issueDate: base.issueDate ?? null,
      taxableDate: base.taxableDate ?? null,
    });
    // As the form's save: tags checked first, default series, the draft, its tags (Task 5).
    const saved = saveDraftWithTags(
      actor,
      {
        ...base,
        ...(args.dueDate && { dueDate: args.dueDate }),
        ...(args.note !== undefined && { note: args.note }),
        exchangeRateMicros: rate?.rateMicros ?? null,
        exchangeRateSource: rate?.source ?? null,
        lines,
        clientId: key,
      },
      args.tags ?? [],
    );
    return draftOfId(ctx, saved.id);
  },
  text: draftText(T.created),
});
