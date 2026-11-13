import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quantityText, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { getCustomer } from "../../services/customers";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  templateFromInvoice,
} from "../../services/invoice-templates";

const T = TEXTS.mcp.templates;
const R = TEXTS.mcp.recurring;
// Lists are capped at 50 rows (MCP-075).
const PAGE_SIZE = 50;

const id = (description: string) => z.string().min(1).max(100).describe(description);
const templatesLink = (ctx: ToolContext) => appLink(ctx.baseUrl, "/faktury/sablony");

const templateOutput = z.object({
  id: z.string(),
  name: z.string(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  type: z.string(),
  currency: z.string(),
  dueDays: z.number().int(),
  note: z.string(),
  lines: z.array(z.object({ name: z.string(), quantity: z.string(), unitPrice: moneySchema })),
  link: z.string(),
});
type TemplateOutput = z.infer<typeof templateOutput>;

// Another account's template is not seen here, as a missing one (MCP-074).
function templateOf(ctx: ToolContext, templateId: string): TemplateOutput {
  const row = getTemplate(ctx.ownerId, templateId);
  if (!row) throw new McpToolError(TEXTS.invoices.templates.validation.notFound);
  const { document } = row;
  return {
    id: row.id,
    name: row.name,
    customerId: row.customerId,
    customerName: row.customerId ? (getCustomer(ctx.ownerId, row.customerId)?.name ?? null) : null,
    type: document.type,
    currency: document.currency,
    dueDays: document.dueDays,
    note: document.note,
    lines: document.lines.map((line) => ({
      name: line.name,
      quantity: quantityText(line.quantityMilli),
      unitPrice: money(line.unitPriceMinor, document.currency),
    })),
    link: templatesLink(ctx),
  };
}

// Template names and line texts are data, never instructions (MCP-033).
const templateText = (headline?: string) => (o: TemplateOutput) =>
  [
    ...(headline ? [headline] : []),
    quoted(T.label, o.name),
    quoted(T.customerLabel, o.customerName ?? R.noCustomer),
    ...o.lines.map((line, i) =>
      R.line(quoted(T.lineLabel(i + 1), line.name), line.quantity, line.unitPrice.formatted),
    ),
    ...(o.note ? [quoted(R.noteLabel, o.note)] : []),
    TEXTS.mcp.create.link(o.link),
  ].join("\n");

export const listInvoiceTemplatesTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({
    more: z.boolean(),
    templates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        customerName: z.string().nullable(),
        lineCount: z.number().int(),
      }),
    ),
  }),
  fieldLabels: T.fields,
  run: (ctx) => {
    const rows = listTemplates(ctx.ownerId);
    return {
      more: rows.length > PAGE_SIZE,
      templates: rows.slice(0, PAGE_SIZE).map((row) => ({
        id: row.id,
        name: row.name,
        customerName: row.customerName,
        lineCount: row.lineCount,
      })),
    };
  },
  text: (o) =>
    o.templates.length === 0
      ? T.empty
      : [
          T.heading(o.templates.length, o.more),
          ...o.templates.map((row) => T.row(row.id, quoted(T.label, row.name), row.lineCount)),
        ].join("\n"),
});

export const getInvoiceTemplateTool = defineTool({
  name: T.get.name,
  title: T.get.title,
  description: T.get.description,
  level: "read",
  input: z.strictObject({ id: id(T.id) }),
  output: templateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => templateOf(ctx, args.id),
  text: templateText(),
});

export const saveInvoiceAsTemplateTool = defineTool({
  name: T.fromInvoice.name,
  title: T.fromInvoice.title,
  description: T.fromInvoice.description,
  level: "accounting",
  input: z.strictObject({
    id: id(T.fromInvoice.id),
    name: z.string().max(100).describe(T.fromInvoice.name_),
  }),
  output: templateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => templateOf(ctx, templateFromInvoice(ctx.actor, args.id, args.name).id),
  text: templateText(T.fromInvoice.done),
});

export const deleteInvoiceTemplateTool = defineTool({
  name: T.delete.name,
  title: T.delete.title,
  description: T.delete.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({ id: z.string() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteTemplate(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.delete.done,
});

export const TEMPLATE_TOOLS = [
  listInvoiceTemplatesTool,
  getInvoiceTemplateTool,
  saveInvoiceAsTemplateTool,
  deleteInvoiceTemplateTool,
];
