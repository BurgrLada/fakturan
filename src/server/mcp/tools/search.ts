import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool } from "../tool";
import { searchCatalog } from "../../services/catalog";
import { searchCustomers } from "../../services/customers";

const T = TEXTS.mcp.read;
const MAX_RESULTS = 10;

const query = (description: string) =>
  z.strictObject({
    query: z.string().trim().min(1, T.queryRequired).max(100).describe(description),
  });

export const searchCustomersTool = defineTool({
  name: T.customers.name,
  title: T.customers.title,
  description: T.customers.description,
  capability: "read",
  input: query(T.customers.query),
  output: z.object({
    customers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        ico: z.string(),
        dic: z.string(),
        email: z.string(),
        city: z.string(),
        link: z.string(),
      }),
    ),
  }),
  run: (ctx, { query: term }) => ({
    customers: searchCustomers(ctx.ownerId, term, MAX_RESULTS).map((row) => ({
      id: row.id,
      name: row.name,
      ico: row.ico,
      dic: row.dic,
      email: row.email,
      city: row.city,
      link: appLink(ctx.baseUrl, `/zakaznici/${row.id}`),
    })),
  }),
  text: (o) =>
    o.customers.length === 0
      ? T.noCustomers
      : [
          T.customers.heading(o.customers.length),
          ...o.customers.map((row) =>
            T.customers.row(
              row.id,
              quoted(T.customers.label, row.name),
              row.ico ? quoted(T.customers.ico, row.ico) : "",
              row.link,
            ),
          ),
        ].join("\n"),
});

export const searchCatalogTool = defineTool({
  name: T.catalog.name,
  title: T.catalog.title,
  description: T.catalog.description,
  capability: "read",
  input: query(T.catalog.query),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        unit: z.string(),
        category: z.string(),
        price: moneySchema,
        link: z.string(),
      }),
    ),
  }),
  run: (ctx, { query: term }) => ({
    items: searchCatalog(ctx.ownerId, term, MAX_RESULTS).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      unit: row.unit,
      category: row.category,
      price: money(row.priceMinor, row.currency),
      link: appLink(ctx.baseUrl, `/cenik/${row.id}`),
    })),
  }),
  text: (o) =>
    o.items.length === 0
      ? T.noItems
      : [
          T.catalog.heading(o.items.length),
          ...o.items.map((row) =>
            T.catalog.row(
              row.id,
              quoted(T.catalog.label, row.name),
              row.price.formatted,
              quoted(T.unitLabel, row.unit),
              row.link,
            ),
          ),
        ].join("\n"),
});
