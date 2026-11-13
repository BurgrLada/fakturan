import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { LANGUAGES } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { lookupCompany } from "../../services/company-lookup";
import {
  archiveCustomer,
  deleteCustomer,
  getCustomer,
  listCustomers,
  restoreCustomer,
  saveCustomer,
  verifyVat,
  type Customer,
} from "../../services/customers";
import { customerInvoiceStats } from "../../services/invoices";

const T = TEXTS.mcp.customers;
const I = TEXTS.mcp.read.invoice;
// Lists are capped at 50 rows (MCP-075).
const PAGE_SIZE = 50;

const id = (description: string) => z.string().min(1).max(100).describe(description);
const text = (max: number, description: string) => z.string().max(max).describe(description);

// Another account's customer is not seen here, as a missing one (MCP-074).
function ownCustomer(ctx: ToolContext, customerId: string): Customer {
  const row = getCustomer(ctx.ownerId, customerId);
  if (!row) throw new McpToolError(TEXTS.customers.validation.notFound);
  return row;
}

const customerLink = (ctx: ToolContext, customerId: string) =>
  appLink(ctx.baseUrl, `/zakaznici/${customerId}`);

const customerFields = {
  id: z.string(),
  name: z.string(),
  ico: z.string(),
  dic: z.string(),
  email: z.string(),
  city: z.string(),
  archived: z.boolean(),
  link: z.string(),
};

function customerOf(ctx: ToolContext, row: Customer) {
  return {
    id: row.id,
    name: row.name,
    ico: row.ico,
    dic: row.dic,
    email: row.email,
    city: row.city,
    archived: row.archivedAt !== null,
    link: customerLink(ctx, row.id),
  };
}

export const listCustomersTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({
    q: z.string().max(100).describe(T.list.q).optional(),
    foreign: z.boolean().describe(T.list.foreign).optional(),
    status: z.enum(["active", "archived", "all"]).describe(T.list.status).optional(),
    page: z.number().int().min(1).describe(T.list.page).optional(),
  }),
  output: z.object({
    page: z.number().int(),
    hasNext: z.boolean(),
    customers: z.array(z.object(customerFields)),
  }),
  fieldLabels: T.fields,
  run: (ctx, filter) => {
    const result = listCustomers(ctx.ownerId, { ...filter, pageSize: PAGE_SIZE });
    return {
      page: result.page,
      hasNext: result.hasNext,
      customers: result.rows.map((row) => customerOf(ctx, row)),
    };
  },
  text: (o) =>
    o.customers.length === 0
      ? T.empty
      : [
          T.heading(o.customers.length, o.page, o.hasNext),
          ...o.customers.map((row) =>
            T.row(
              row.id,
              quoted(T.nameLabel, row.name) + (row.archived ? T.archivedMark : ""),
              row.ico,
              row.link,
            ),
          ),
        ].join("\n"),
});

export const getCustomerTool = defineTool({
  name: T.get.name,
  title: T.get.title,
  description: T.get.description,
  level: "read",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({
    ...customerFields,
    street: z.string(),
    zip: z.string(),
    country: z.string(),
    phone: z.string(),
    extraEmails: z.array(z.string()),
    note: z.string(),
    dueDays: z.number().int().nullable(),
    language: z.string().nullable(),
    currency: z.string().nullable(),
    remindersEnabled: z.boolean().nullable(),
    vatValid: z.boolean().nullable(),
    totals: z.array(
      z.object({
        currency: z.string(),
        invoiced: moneySchema,
        paid: moneySchema,
        outstanding: moneySchema,
        advanceOpen: moneySchema,
      }),
    ),
    averageDays: z.number().nullable(),
    invoices: z.array(
      z.object({
        id: z.string(),
        number: z.string().nullable(),
        status: z.string(),
        total: moneySchema,
        link: z.string(),
      }),
    ),
    hasMoreInvoices: z.boolean(),
  }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const row = ownCustomer(ctx, args.id);
    const stats = customerInvoiceStats(ctx.ownerId, row.id);
    return {
      ...customerOf(ctx, row),
      street: row.street,
      zip: row.zip,
      country: row.country,
      phone: row.phone,
      extraEmails: row.extraEmails,
      note: row.note,
      dueDays: row.dueDays,
      language: row.language,
      currency: row.currency,
      remindersEnabled: row.remindersEnabled,
      vatValid: row.vatValid,
      totals: stats.sums.map((sum) => ({
        currency: sum.currency,
        invoiced: money(sum.invoicedMinor, sum.currency),
        paid: money(sum.paidMinor, sum.currency),
        outstanding: money(sum.outstandingMinor, sum.currency),
        advanceOpen: money(sum.advanceOpenMinor, sum.currency),
      })),
      averageDays: stats.averageDays,
      invoices: stats.rows.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        total: money(invoice.totalMinor, invoice.currency),
        link: appLink(ctx.baseUrl, `/faktury/${invoice.id}`),
      })),
      hasMoreInvoices: stats.hasMore,
    };
  },
  text: (o) =>
    [
      T.card(quoted(T.nameLabel, o.name), o.ico, o.dic, o.email),
      ...(o.note ? [quoted(T.noteLabel, o.note)] : []),
      ...o.totals.map((sum) =>
        T.totals(sum.currency, sum.invoiced.formatted, sum.outstanding.formatted),
      ),
      ...(o.averageDays === null ? [] : [T.averageDays(o.averageDays)]),
      ...o.invoices.map((invoice) =>
        T.invoice(
          invoice.number ?? "–",
          (I.statuses as Record<string, string>)[invoice.status] ?? invoice.status,
          invoice.total.formatted,
        ),
      ),
      o.link,
    ].join("\n"),
});

export const lookupCompanyAresTool = defineTool({
  name: T.ares.name,
  title: T.ares.title,
  description: T.ares.description,
  level: "read",
  input: z.strictObject({ ico: z.string().min(1).max(20).describe(T.ares.ico) }),
  output: z.object({
    found: z.boolean(),
    company: z
      .object({
        ico: z.string(),
        name: z.string(),
        dic: z.string(),
        street: z.string(),
        city: z.string(),
        zip: z.string(),
        country: z.string(),
      })
      .nullable(),
  }),
  fieldLabels: T.fields,
  run: async (ctx, args) => {
    const company = await lookupCompany(ctx.actor, args.ico);
    return { found: company !== null, company };
  },
  text: (o) =>
    o.company
      ? [
          T.ares.found(o.company.ico),
          quoted(T.nameLabel, o.company.name),
          quoted(T.fields.dic, o.company.dic),
          quoted(
            T.fields.street,
            [o.company.street, o.company.zip, o.company.city, o.company.country]
              .filter(Boolean)
              .join(", "),
          ),
        ].join("\n")
      : T.ares.notFound,
});

const S = T.save;

export const saveCustomerTool = defineTool({
  name: S.name,
  title: S.title,
  description: S.description,
  level: "drafts",
  input: z.strictObject({
    id: id(S.id).optional(),
    name: text(200, S.name_).optional(),
    street: text(200, S.street).optional(),
    city: text(100, S.city).optional(),
    zip: text(20, S.zip).optional(),
    country: text(60, S.country).optional(),
    ico: text(20, S.ico).optional(),
    dic: text(24, S.dic).optional(),
    email: text(200, S.email).optional(),
    extraEmails: z.array(z.string().max(200)).max(10).describe(S.extraEmails).optional(),
    phone: text(40, S.phone).optional(),
    note: text(2000, S.note).optional(),
    dueDays: z.number().int().nullable().describe(S.dueDays).optional(),
    language: z.enum(LANGUAGES).nullable().describe(S.language).optional(),
    currency: z.enum(CURRENCIES).nullable().describe(S.currency).optional(),
    remindersEnabled: z.boolean().nullable().describe(S.remindersEnabled).optional(),
  }),
  output: z.object({ id: z.string(), created: z.boolean(), duplicateOfIco: z.string().nullable() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    // An edit sends the whole form as the web does: what the assistant leaves out stays.
    const { id: customerId, ...fields } = args;
    const base = customerId
      ? ownCustomer(ctx, customerId)
      : {
          name: "",
          street: "",
          city: "",
          zip: "",
          country: "",
          ico: "",
          dic: "",
          email: "",
          extraEmails: [],
          phone: "",
          note: "",
          dueDays: null,
          language: null,
          currency: null,
          designId: null,
          remindersEnabled: null,
        };
    const saved = saveCustomer(ctx.actor, {
      id: customerId,
      name: fields.name ?? base.name,
      street: fields.street ?? base.street,
      city: fields.city ?? base.city,
      zip: fields.zip ?? base.zip,
      country: fields.country ?? base.country,
      ico: fields.ico ?? base.ico,
      dic: fields.dic ?? base.dic,
      email: fields.email ?? base.email,
      extraEmails: fields.extraEmails ?? base.extraEmails,
      phone: fields.phone ?? base.phone,
      note: fields.note ?? base.note,
      dueDays: fields.dueDays === undefined ? base.dueDays : fields.dueDays,
      language: fields.language === undefined ? base.language : fields.language,
      currency: fields.currency === undefined ? base.currency : fields.currency,
      designId: base.designId,
      remindersEnabled:
        fields.remindersEnabled === undefined ? base.remindersEnabled : fields.remindersEnabled,
    });
    return { id: saved.id, created: !customerId, duplicateOfIco: saved.duplicateOfIco };
  },
  text: (o) =>
    [
      o.created ? S.created : S.updated,
      `ID: ${o.id}`,
      ...(o.duplicateOfIco ? [S.duplicateIco(o.duplicateOfIco)] : []),
    ].join("\n"),
});

const done = z.object({ id: z.string() });

function simple(
  texts: { name: string; title: string; description: string; done: string },
  level: "drafts" | "full",
  action: (ctx: ToolContext, customerId: string) => void,
) {
  return defineTool({
    name: texts.name,
    title: texts.title,
    description: texts.description,
    level,
    input: z.strictObject({ id: id(T.id) }),
    output: done,
    fieldLabels: T.fields,
    run: (ctx, args) => {
      action(ctx, args.id);
      return { id: args.id };
    },
    text: () => texts.done,
  });
}

export const archiveCustomerTool = simple(T.archive, "drafts", (ctx, customerId) =>
  archiveCustomer(ctx.actor, customerId),
);
export const restoreCustomerTool = simple(T.restore, "drafts", (ctx, customerId) =>
  restoreCustomer(ctx.actor, customerId),
);
export const deleteCustomerTool = simple(T.delete, "full", (ctx, customerId) =>
  deleteCustomer(ctx.actor, customerId),
);

export const verifyCustomerVatTool = defineTool({
  name: T.verifyVat.name,
  title: T.verifyVat.title,
  description: T.verifyVat.description,
  level: "drafts",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({ id: z.string(), state: z.string(), verifiedAt: z.string().nullable() }),
  fieldLabels: T.fields,
  run: async (ctx, args) => {
    const status = await verifyVat(ctx.actor, args.id);
    return {
      id: args.id,
      state: status.state,
      verifiedAt: status.verifiedAt?.toISOString() ?? null,
    };
  },
  text: (o) => T.verifyVat.states[o.state] ?? o.state,
});

export const CUSTOMER_TOOLS = [
  listCustomersTool,
  getCustomerTool,
  lookupCompanyAresTool,
  saveCustomerTool,
  archiveCustomerTool,
  restoreCustomerTool,
  verifyCustomerVatTool,
  deleteCustomerTool,
];
