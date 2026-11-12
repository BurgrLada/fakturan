import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { parseMoney } from "@/lib/money";
import { isCalendarDate } from "@/lib/number-format";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import { MAX_PAYMENT_NOTE, PAYMENT_CHANNELS } from "@/lib/payments";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { getInvoice, type InvoiceDetail } from "../../services/invoices";
import {
  addPayment,
  addRefund,
  deletePayment,
  listPayments,
  markPaid,
  markPaidMany,
  updatePayment,
  type Payment,
} from "../../services/payments";

const T = TEXTS.mcp.payments;
const R = TEXTS.mcp.read;

const id = (description: string) => z.string().min(1).max(100).describe(description);
// Amounts arrive as the text a person types and are read by the form's own parser (MCP-043).
const amount = (description: string) =>
  z
    .string()
    .refine((value) => (parseMoney(value) ?? 0) > 0, T.amountInvalid)
    .describe(description);
const paidOn = (description: string) =>
  z.string().refine(isCalendarDate, TEXTS.mcp.create.date).describe(description);

// Another account's invoice is not seen here, as a missing one (MCP-074).
function ownInvoice(ctx: ToolContext, invoiceId: string): InvoiceDetail {
  const row = getInvoice(ctx.ownerId, invoiceId);
  if (!row) throw new McpToolError(TEXTS.invoices.validation.notFound);
  return row;
}

// A payment is addressed through its invoice, as on the invoice page of the web.
function ownPayment(ctx: ToolContext, invoiceId: string, paymentId: string): Payment {
  ownInvoice(ctx, invoiceId);
  const row = listPayments(ctx.ownerId, invoiceId).find((one) => one.id === paymentId);
  if (!row) throw new McpToolError(TEXTS.payments.errors.notFound);
  return row;
}

const balance = z.object({
  invoiceId: z.string(),
  // Send it back with the next operation on the invoice (MCP-072).
  revision: z.number().int(),
  status: z.string(),
  paid: moneySchema,
  remaining: moneySchema,
  link: z.string(),
});
const withPayment = balance.extend({ paymentId: z.string() });

function balanceOf(ctx: ToolContext, invoiceId: string): z.infer<typeof balance> {
  const row = getInvoice(ctx.ownerId, invoiceId)!;
  return {
    invoiceId: row.id,
    revision: row.revision,
    status: row.status,
    paid: money(row.paidMinor, row.currency),
    remaining: money(amountDue(row), row.currency),
    link: appLink(ctx.baseUrl, `/faktury/${row.id}`),
  };
}

const balanceText = (headline: string) => (o: z.infer<typeof balance>) =>
  [
    headline,
    T.summary(
      (R.invoice.statuses as Record<string, string>)[o.status] ?? o.status,
      o.paid.formatted,
      o.remaining.formatted,
    ),
    TEXTS.mcp.create.revision(o.revision),
    o.link,
  ].join("\n");

const paymentFields = {
  paidOn: paidOn(T.paidOn),
  amount: amount(T.amount),
  currency: z.enum(CURRENCIES).describe(T.currency).optional(),
  credited: amount(T.credited).optional(),
  method: z.enum(PAYMENT_CHANNELS).describe(T.method),
  note: z.string().max(MAX_PAYMENT_NOTE).describe(T.note).optional(),
};

const newPaymentInput = z.strictObject({
  invoiceId: id(T.invoiceId),
  revision: z.number().int().describe(T.revision),
  ...paymentFields,
});

function newPayment(
  texts: { name: string; title: string; description: string; done: string },
  add: typeof addPayment,
) {
  return defineTool({
    name: texts.name,
    title: texts.title,
    description: texts.description,
    level: "accounting",
    input: newPaymentInput,
    output: withPayment,
    fieldLabels: T.fields,
    run: (ctx, args) => {
      const invoice = ownInvoice(ctx, args.invoiceId);
      const saved = add(ctx.actor, invoice.id, {
        revision: args.revision,
        paidOn: args.paidOn,
        amountMinor: parseMoney(args.amount)!,
        // The web dialog starts with the invoice's currency.
        currency: args.currency ?? invoice.currency,
        creditedMinor: args.credited === undefined ? null : parseMoney(args.credited)!,
        method: args.method,
        note: args.note ?? "",
      });
      return { ...balanceOf(ctx, invoice.id), paymentId: saved.id };
    },
    text: balanceText(texts.done),
  });
}

export const addPaymentTool = newPayment(T.add, addPayment);
export const addRefundTool = newPayment(T.refund, addRefund);

export const updatePaymentTool = defineTool({
  name: T.update.name,
  title: T.update.title,
  description: T.update.description,
  level: "accounting",
  input: z.strictObject({
    invoiceId: id(T.invoiceId),
    paymentId: id(T.paymentId),
    revision: z.number().int().describe(T.revision),
    paidOn: paidOn(T.paidOn).optional(),
    amount: amount(T.amount).optional(),
    currency: z.enum(CURRENCIES).describe(T.currency).optional(),
    credited: amount(T.credited).optional(),
    method: z.enum(PAYMENT_CHANNELS).describe(T.method).optional(),
    note: z.string().max(MAX_PAYMENT_NOTE).describe(T.note).optional(),
  }),
  output: withPayment,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const found = ownPayment(ctx, args.invoiceId, args.paymentId);
    // The web dialog shows a refund as a positive amount; the service keeps its sign.
    updatePayment(ctx.actor, found.id, {
      revision: args.revision,
      paidOn: args.paidOn ?? found.paidOn,
      amountMinor:
        args.amount === undefined ? Math.abs(found.amountMinor) : parseMoney(args.amount)!,
      currency: args.currency ?? found.currency,
      creditedMinor:
        args.credited === undefined
          ? found.creditedMinor === null
            ? null
            : Math.abs(found.creditedMinor)
          : parseMoney(args.credited)!,
      method: args.method ?? found.method,
      note: args.note ?? found.note,
    });
    return { ...balanceOf(ctx, args.invoiceId), paymentId: found.id };
  },
  text: balanceText(T.update.done),
});

export const deletePaymentTool = defineTool({
  name: T.delete.name,
  title: T.delete.title,
  description: T.delete.description,
  level: "full",
  input: z.strictObject({
    invoiceId: id(T.invoiceId),
    paymentId: id(T.paymentId),
    revision: z.number().int().describe(T.revision),
  }),
  output: balance,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const found = ownPayment(ctx, args.invoiceId, args.paymentId);
    deletePayment(ctx.actor, found.id, args.revision);
    return balanceOf(ctx, args.invoiceId);
  },
  text: balanceText(T.delete.done),
});

export const markPaidTool = defineTool({
  name: T.markPaid.name,
  title: T.markPaid.title,
  description: T.markPaid.description,
  level: "accounting",
  input: z.strictObject({
    id: id(T.markPaid.id),
    revision: z.number().int().describe(T.revision),
    paidOn: paidOn(T.markPaid.paidOn).optional(),
  }),
  output: balance,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const invoice = ownInvoice(ctx, args.id);
    markPaid(ctx.actor, invoice.id, { revision: args.revision, paidOn: args.paidOn });
    return balanceOf(ctx, invoice.id);
  },
  text: balanceText(T.markPaid.done),
});

export const markPaidManyTool = defineTool({
  name: T.markPaidMany.name,
  title: T.markPaidMany.title,
  description: T.markPaidMany.description,
  level: "accounting",
  input: z.strictObject({
    ids: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(MAX_BULK_DOCUMENTS)
      .describe(T.markPaidMany.ids),
  }),
  output: z.object({ done: z.number().int(), skipped: z.number().int() }),
  fieldLabels: T.fields,
  // The service skips what it cannot settle, another account's documents included.
  run: (ctx, args) => markPaidMany(ctx.actor, args.ids),
  text: (o) => T.markPaidMany.done(o.done, o.skipped),
});

export const PAYMENT_TOOLS = [
  addPaymentTool,
  addRefundTool,
  updatePaymentTool,
  markPaidTool,
  markPaidManyTool,
  deletePaymentTool,
];
