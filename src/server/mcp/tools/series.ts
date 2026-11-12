import { z } from "zod";
import { DOCUMENT_TYPES, formatNumber, isCalendarDate, RESET_PERIODS } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { defineTool, type ToolContext } from "../tool";
import {
  deleteSeries,
  listSeries,
  saveSeries,
  setDefaultSeries,
  setNextNumber,
  type SeriesRow,
} from "../../services/number-series";

const T = TEXTS.mcp.series;

const id = (description: string) => z.string().min(1).max(100).describe(description);

const seriesOutput = z.object({
  id: z.string(),
  name: z.string(),
  documentType: z.string(),
  template: z.string(),
  reset: z.string(),
  isDefault: z.boolean(),
  used: z.boolean(),
  // The sequence and the number the next issued document of this series gets today.
  next: z.number().int(),
  nextNumber: z.string(),
});
type SeriesOutput = z.infer<typeof seriesOutput>;

const seriesOf = (ctx: ToolContext, row: SeriesRow): SeriesOutput => ({
  id: row.id,
  name: row.name,
  documentType: row.documentType,
  template: row.template,
  reset: row.reset,
  isDefault: row.isDefault,
  used: row.used,
  next: row.next,
  nextNumber: formatNumber(row.template, ctx.today, row.next),
});

// Another account's series is not seen here, as a missing one (MCP-074).
function seriesById(ctx: ToolContext, seriesId: string): SeriesOutput {
  const row = listSeries(ctx.ownerId, ctx.today).find((series) => series.id === seriesId);
  if (!row) throw new McpToolError(TEXTS.numberSeries.errors.notFound);
  return seriesOf(ctx, row);
}

const typeLabel = (type: string) =>
  (TEXTS.numberSeries.documentTypes as Record<string, string>)[type] ?? type;

const rowText = (o: SeriesOutput) =>
  T.row(o.id, o.name, typeLabel(o.documentType), o.template, o.nextNumber) +
  (o.isDefault ? T.defaultMark : "");

export const listNumberSeriesTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ series: z.array(seriesOutput) }),
  fieldLabels: T.fields,
  run: (ctx) => ({
    series: listSeries(ctx.ownerId, ctx.today).map((row) => seriesOf(ctx, row)),
  }),
  text: (o) => [T.heading, ...o.series.map(rowText)].join("\n"),
});

export const saveNumberSeriesTool = defineTool({
  name: T.save.name,
  title: T.save.title,
  description: T.save.description,
  level: "accounting",
  input: z.strictObject({
    id: id(T.id).optional(),
    name: z.string().max(100).describe(T.name),
    documentType: z.enum(DOCUMENT_TYPES).describe(T.documentType),
    template: z.string().max(50).describe(T.template),
    reset: z.enum(RESET_PERIODS).describe(T.reset),
  }),
  output: seriesOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => seriesById(ctx, saveSeries(ctx.actor, args)),
  text: (o) => [T.save.done, rowText(o)].join("\n"),
});

export const setDefaultSeriesTool = defineTool({
  name: T.setDefault.name,
  title: T.setDefault.title,
  description: T.setDefault.description,
  level: "accounting",
  input: z.strictObject({ id: id(T.id) }),
  output: seriesOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setDefaultSeries(ctx.actor, args.id);
    return seriesById(ctx, args.id);
  },
  text: (o) => [T.setDefault.done, rowText(o)].join("\n"),
});

export const setNextNumberTool = defineTool({
  name: T.setNext.name,
  title: T.setNext.title,
  description: T.setNext.description,
  level: "issue_send",
  input: z.strictObject({
    id: id(T.id),
    next: z.number().int().describe(T.setNext.next),
    date: z
      .string()
      .refine(isCalendarDate, TEXTS.mcp.create.date)
      .describe(T.setNext.date)
      .optional(),
  }),
  output: z.object({ id: z.string(), next: z.number().int() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setNextNumber(ctx.actor, args.id, args.next, args.date);
    return { id: args.id, next: args.next };
  },
  text: (o) => T.setNext.done(o.next),
});

export const deleteNumberSeriesTool = defineTool({
  name: T.delete.name,
  title: T.delete.title,
  description: T.delete.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({ id: z.string() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteSeries(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.delete.done,
});

export const SERIES_TOOLS = [
  listNumberSeriesTool,
  saveNumberSeriesTool,
  setDefaultSeriesTool,
  setNextNumberTool,
  deleteNumberSeriesTool,
];
