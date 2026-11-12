import { z } from "zod";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { MAX_DOCUMENT_LINES } from "@/lib/invoice";
import { parseQuantity } from "@/lib/invoice-totals";
import { parseMoney } from "@/lib/money";
import { isCalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { getCatalogItem } from "../../services/catalog";
import { getCustomer } from "../../services/customers";
import { draftRate } from "../../services/exchange-rates";
import {
  getInvoice,
  MAX_DOCUMENT_TEXT,
  MAX_LINE_NAME,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
  type InvoiceDetail,
} from "../../services/invoices";
import { ensureDefaultSeries } from "../../services/number-series";
import { getPreferences } from "../../services/preferences";

const T = TEXTS.mcp.create;

// Amounts arrive as the decimal text a person would type and are read by the web form's own parsers
// (MCP-043, ARC-002); the tool does no arithmetic of its own.
const isQuantity = (value: string) => parseQuantity(value) !== null;
const isPrice = (value: string) => (parseMoney(value) ?? -1) >= 0;
const date = (description: string) =>
  z.string().refine(isCalendarDate, T.date).describe(description).optional();

const lineInput = z
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

const input = z.strictObject({
  customerId: z.string().min(1).max(100).describe(T.customerId),
  lines: z.array(lineInput).min(1, T.linesRequired).max(MAX_DOCUMENT_LINES).describe(T.lines),
  issueDate: date(T.issueDate),
  dueDate: date(T.dueDate),
  currency: z.enum(CURRENCIES).describe(T.currency).optional(),
  note: z.string().max(MAX_DOCUMENT_TEXT).describe(T.note).optional(),
  idempotency_key: z.uuid().describe(T.idempotencyKey).optional(),
});

const output = z.object({
  id: z.string(),
  customerName: z.string(),
  lines: z.array(z.object({ name: z.string(), total: moneySchema })),
  note: z.string(),
  total: moneySchema,
  link: z.string(),
});

type Output = z.infer<typeof output>;

function outputOf(ctx: ToolContext, row: InvoiceDetail): Output {
  return {
    id: row.id,
    customerName: row.customerName,
    lines: row.lines.map((line) => ({
      name: line.name,
      total: money(line.netMinor, row.currency),
    })),
    note: row.note,
    total: money(row.totalMinor, row.currency),
    link: appLink(ctx.baseUrl, `/faktury/${row.id}/upravit`),
  };
}

// A line as the form makes it: a picked catalog item fills name, description, unit and price, and
// what the assistant states wins, as when a person edits the picked line.
function lineOf(
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
    description: item?.description ?? "",
    quantityMilli: parseQuantity(line.quantity)!,
    unit: item?.unit ?? defaultUnit,
    unitPriceMinor:
      line.unitPrice === undefined ? (item?.priceMinor ?? 0) : parseMoney(line.unitPrice)!,
    discountKind: "none",
    discountValue: 0,
  };
}

export const createDraftInvoiceTool = defineTool({
  name: T.name,
  title: T.title,
  description: T.description,
  capability: "create",
  input,
  output,
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
      return outputOf(ctx, earlier);
    }

    // The web picker offers only the account's active customers; another account's looks missing.
    const customer = getCustomer(ownerId, args.customerId);
    if (!customer || customer.archivedAt) throw new McpToolError(TEXTS.mcp.read.customerNotFound);
    // As the form's save: the default series exist before the draft takes one (idempotent).
    ensureDefaultSeries(actor);
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
    const saved = saveDraft(actor, {
      ...base,
      ...(args.dueDate && { dueDate: args.dueDate }),
      ...(args.note !== undefined && { note: args.note }),
      exchangeRateMicros: rate?.rateMicros ?? null,
      exchangeRateSource: rate?.source ?? null,
      lines,
      clientId: key,
    });
    return outputOf(ctx, getInvoice(ownerId, saved.id)!);
  },
  text: (o) =>
    [
      T.created,
      quoted(T.customer, o.customerName),
      ...o.lines.map((line, i) =>
        T.line(quoted(T.lineLabel(i + 1), line.name), line.total.formatted),
      ),
      ...(o.note ? [quoted(T.noteLabel, o.note)] : []),
      T.total(o.total.formatted),
      T.link(o.link),
    ].join("\n"),
});
