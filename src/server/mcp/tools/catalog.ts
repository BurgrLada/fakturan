import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { parseMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import {
  archiveCatalogItem,
  deleteUnit,
  getCatalogItem,
  listCatalog,
  listCategories,
  listUnits,
  restoreCatalogItem,
  saveCatalogItem,
  saveLineToCatalog,
  saveUnit,
  type CatalogItem,
} from "../../services/catalog";
import { getPreferences } from "../../services/preferences";

const T = TEXTS.mcp.catalog;
// Lists are capped at 50 rows (MCP-075).
const PAGE_SIZE = 50;

const id = (description: string) => z.string().min(1).max(100).describe(description);
// Prices arrive as the text a person types and are read by the form's own parser (MCP-043).
const price = (description: string) =>
  z
    .string()
    .refine((value) => (parseMoney(value) ?? -1) >= 0, T.priceInvalid)
    .describe(description);

function ownItem(ctx: ToolContext, itemId: string): CatalogItem {
  const row = getCatalogItem(ctx.ownerId, itemId);
  if (!row) throw new McpToolError(TEXTS.catalog.validation.notFound);
  return row;
}

const itemOutput = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  unit: z.string(),
  price: moneySchema,
  category: z.string(),
  tags: z.array(z.string()),
  archived: z.boolean(),
  link: z.string(),
});

const itemOf = (ctx: ToolContext, row: CatalogItem) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  unit: row.unit,
  price: money(row.priceMinor, row.currency),
  category: row.category,
  tags: row.tags,
  archived: row.archivedAt !== null,
  link: appLink(ctx.baseUrl, `/cenik/${row.id}`),
});

const itemRow = (row: z.infer<typeof itemOutput>) =>
  T.row(
    row.id,
    quoted(T.nameLabel, row.name) + (row.archived ? T.archivedMark : ""),
    row.price.formatted,
    row.unit,
    row.link,
  ) + (row.category ? ` · ${quoted(T.categoryLabel, row.category)}` : "");

export const listCatalogTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({
    q: z.string().max(100).describe(T.list.q).optional(),
    category: z.string().max(60).describe(T.list.category).optional(),
    status: z.enum(["active", "archived", "all"]).describe(T.list.status).optional(),
    sort: z.enum(["name", "usage"]).describe(T.list.sort).optional(),
    page: z.number().int().min(1).describe(T.list.page).optional(),
  }),
  output: z.object({ page: z.number().int(), hasNext: z.boolean(), items: z.array(itemOutput) }),
  fieldLabels: T.fields,
  run: (ctx, filter) => {
    const result = listCatalog(ctx.ownerId, { ...filter, pageSize: PAGE_SIZE });
    return {
      page: result.page,
      hasNext: result.hasNext,
      items: result.rows.map((row) => itemOf(ctx, row)),
    };
  },
  text: (o) =>
    o.items.length === 0
      ? T.empty
      : [T.heading(o.items.length, o.page, o.hasNext), ...o.items.map(itemRow)].join("\n"),
});

export const getCatalogItemTool = defineTool({
  name: T.get.name,
  title: T.get.title,
  description: T.get.description,
  level: "read",
  input: z.strictObject({ id: id(T.id) }),
  output: itemOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => itemOf(ctx, ownItem(ctx, args.id)),
  text: (o) =>
    [
      itemRow(o),
      ...(o.description ? [quoted(T.fields.description, o.description)] : []),
      ...(o.tags.length > 0 ? [quoted(T.fields.tags, o.tags.join(", "))] : []),
    ].join("\n"),
});

export const listCatalogCategoriesTool = defineTool({
  name: T.categories.name,
  title: T.categories.title,
  description: T.categories.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ categories: z.array(z.string()) }),
  run: (ctx) => ({ categories: listCategories(ctx.ownerId) }),
  text: (o) =>
    o.categories.length === 0
      ? T.noCategories
      : [
          T.categories.heading,
          ...o.categories.map((name) => `- ${quoted(T.categoryLabel, name)}`),
        ].join("\n"),
});

export const listUnitsTool = defineTool({
  name: T.units.name,
  title: T.units.title,
  description: T.units.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ units: z.array(z.object({ id: z.string().nullable(), name: z.string() })) }),
  run: (ctx) => ({ units: listUnits(ctx.ownerId) }),
  text: (o) =>
    [
      T.units.heading,
      ...o.units.map(
        (unit) => `- ${unit.id ? `${unit.id} · ` : ""}${quoted(T.unitLabel, unit.name)}`,
      ),
    ].join("\n"),
});

const S = T.save;

export const saveCatalogItemTool = defineTool({
  name: S.name,
  title: S.title,
  description: S.description,
  level: "drafts",
  input: z.strictObject({
    id: id(S.id).optional(),
    name: z.string().max(200).describe(S.name_).optional(),
    description: z.string().max(2000).describe(S.description_).optional(),
    unit: z.string().max(20).describe(S.unit).optional(),
    price: price(S.price).optional(),
    currency: z.enum(CURRENCIES).describe(S.currency).optional(),
    category: z.string().max(60).describe(S.category).optional(),
    tags: z.array(z.string().max(30)).max(10).describe(S.tags).optional(),
  }),
  output: z.object({ id: z.string(), created: z.boolean() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const existing = args.id ? ownItem(ctx, args.id) : null;
    if (!existing && args.price === undefined) throw new McpToolError(T.priceRequired);
    // A new item takes the account's currency and unit, as the empty web form does.
    const preferences = getPreferences(ctx.ownerId);
    const saved = saveCatalogItem(ctx.actor, {
      id: existing?.id,
      name: args.name ?? existing?.name ?? "",
      description: args.description ?? existing?.description ?? "",
      unit: args.unit ?? existing?.unit ?? preferences.unit,
      priceMinor: args.price === undefined ? existing!.priceMinor : parseMoney(args.price)!,
      currency: args.currency ?? existing?.currency ?? preferences.currency,
      category: args.category ?? existing?.category ?? "",
      tags: args.tags ?? existing?.tags ?? [],
    });
    return { id: saved.id, created: !existing };
  },
  text: (o) => [o.created ? S.created : S.updated, `ID: ${o.id}`].join("\n"),
});

const done = z.object({ id: z.string() });

export const archiveCatalogItemTool = defineTool({
  name: T.archive.name,
  title: T.archive.title,
  description: T.archive.description,
  level: "drafts",
  input: z.strictObject({ id: id(T.id) }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    archiveCatalogItem(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.archive.done,
});

export const restoreCatalogItemTool = defineTool({
  name: T.restore.name,
  title: T.restore.title,
  description: T.restore.description,
  level: "drafts",
  input: z.strictObject({ id: id(T.id) }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    restoreCatalogItem(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.restore.done,
});

export const saveUnitTool = defineTool({
  name: T.saveUnit.name,
  title: T.saveUnit.title,
  description: T.saveUnit.description,
  level: "drafts",
  input: z.strictObject({ name: z.string().max(100).describe(T.saveUnit.unitName) }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) => saveUnit(ctx.actor, args.name),
  text: (o) => [T.saveUnit.done, `ID: ${o.id}`].join("\n"),
});

export const deleteUnitTool = defineTool({
  name: T.deleteUnit.name,
  title: T.deleteUnit.title,
  description: T.deleteUnit.description,
  level: "full",
  input: z.strictObject({ id: id(T.deleteUnit.id) }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteUnit(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.deleteUnit.done,
});

const L = T.fromLine;

export const saveLineToCatalogTool = defineTool({
  name: L.name,
  title: L.title,
  description: L.description,
  level: "drafts",
  input: z.strictObject({
    name: z.string().max(200).describe(L.name_),
    description: z.string().max(2000).describe(L.description_).optional(),
    unit: z.string().max(20).describe(L.unit),
    unitPrice: price(L.unitPrice),
    currency: z.enum(CURRENCIES).describe(L.currency),
  }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) =>
    saveLineToCatalog(ctx.actor, {
      name: args.name,
      description: args.description,
      unit: args.unit,
      priceMinor: parseMoney(args.unitPrice)!,
      currency: args.currency,
    }),
  text: (o) => [L.done, `ID: ${o.id}`].join("\n"),
});

export const CATALOG_TOOLS = [
  listCatalogTool,
  getCatalogItemTool,
  listCatalogCategoriesTool,
  listUnitsTool,
  saveCatalogItemTool,
  archiveCatalogItemTool,
  restoreCatalogItemTool,
  saveUnitTool,
  deleteUnitTool,
  saveLineToCatalogTool,
];
