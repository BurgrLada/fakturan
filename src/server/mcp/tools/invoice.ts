import { z } from "zod";
import { INVOICE_STATUSES } from "@/lib/invoice";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quantityText, quoted } from "../format";
import { defineTool } from "../tool";
import { relatedDocuments } from "../../services/credit-notes";
import { listEmailLog } from "../../services/invoice-mail";
import { listVersions } from "../../services/invoice-versions";
import { getInvoice, getInvoiceByNumber } from "../../services/invoices";
import { listPayments } from "../../services/payments";

const T = TEXTS.mcp.read;
const I = T.invoice;

const input = z
  .strictObject({
    id: z.string().min(1).max(100).describe(I.id).optional(),
    number: z.string().trim().min(1).max(100).describe(I.number).optional(),
  })
  .refine((value) => (value.id === undefined) !== (value.number === undefined), {
    message: T.invoiceSelector,
  });

const output = z.object({
  id: z.string(),
  number: z.string().nullable(),
  type: z.string(),
  status: z.enum(INVOICE_STATUSES),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  taxableDate: z.string().nullable(),
  currency: z.string(),
  variableSymbol: z.string().nullable(),
  // Later writes send this back for optimistic concurrency (MCP-072).
  revision: z.number().int(),
  customer: z.object({ id: z.string().nullable(), name: z.string() }),
  lines: z.array(
    z.object({
      position: z.number().int(),
      name: z.string(),
      description: z.string(),
      quantityMilli: z.number().int(),
      unit: z.string(),
      unitPrice: moneySchema,
      net: moneySchema,
    }),
  ),
  totals: z.object({
    subtotal: moneySchema,
    discount: moneySchema,
    rounding: moneySchema,
    total: moneySchema,
    paid: moneySchema,
    credits: moneySchema,
    advance: moneySchema,
    remaining: moneySchema,
  }),
  payments: z.array(
    z.object({
      id: z.string(),
      paidOn: z.string(),
      kind: z.string(),
      method: z.string(),
      amount: moneySchema,
      note: z.string(),
    }),
  ),
  note: z.string(),
  textBefore: z.string(),
  textAfter: z.string(),
  reference: z.string(),
  orderRef: z.string(),
  tags: z.array(z.string()),
  versions: z.array(z.object({ id: z.string(), createdAt: z.string() })),
  mailLog: z.array(z.object({ id: z.string(), status: z.string() })),
  related: z.array(z.object({ id: z.string(), type: z.string(), number: z.string().nullable() })),
  link: z.string(),
});

export const getInvoiceTool = defineTool({
  name: I.name,
  title: I.title,
  description: I.description,
  level: "read",
  input,
  output,
  run: (ctx, { id, number }) => {
    // Another account's invoice and a missing one are told apart by nothing (MCP-022).
    const found =
      id !== undefined ? getInvoice(ctx.ownerId, id) : getInvoiceByNumber(ctx.ownerId, number!);
    if (!found) throw new McpToolError(T.invoiceNotFound);
    const currency = found.currency;
    const related = relatedDocuments(ctx.ownerId, found.id);
    const m = (minor: number) => money(minor, currency);
    return {
      id: found.id,
      number: found.number,
      type: found.type,
      status: found.status,
      issueDate: found.issueDate,
      dueDate: found.dueDate,
      taxableDate: found.taxableDate,
      currency,
      variableSymbol: found.variableSymbol,
      revision: found.revision,
      customer: { id: found.customerId, name: found.customerName },
      lines: found.lines.map((line) => ({
        position: line.position,
        name: line.name,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPrice: m(line.unitPriceMinor),
        net: m(line.netMinor),
      })),
      totals: {
        subtotal: m(found.subtotalMinor),
        discount: m(found.discountMinor),
        rounding: m(found.roundingMinor),
        total: m(found.totalMinor),
        paid: m(found.paidMinor),
        credits: m(found.creditsMinor),
        advance: m(found.advanceMinor),
        remaining: m(amountDue(found)),
      },
      payments: listPayments(ctx.ownerId, found.id).map((entry) => ({
        id: entry.id,
        paidOn: entry.paidOn,
        kind: entry.kind,
        method: entry.method,
        amount: money(entry.amountMinor, entry.currency),
        note: entry.note,
      })),
      note: found.note,
      textBefore: found.textBefore,
      textAfter: found.textAfter,
      reference: found.reference,
      orderRef: found.orderRef,
      tags: found.tags.map((tag) => tag.name),
      // The same reads the web detail page composes.
      versions: listVersions(ctx.ownerId, found.id).map((version) => ({
        id: version.id,
        createdAt: version.createdAt.toISOString(),
      })),
      mailLog: listEmailLog(ctx.ownerId, found.id).map((row) => ({
        id: row.id,
        status: row.status,
      })),
      related: [related.parent, ...related.children]
        .filter((doc) => doc !== null)
        .map((doc) => ({ id: doc.id, type: doc.type, number: doc.number })),
      link: appLink(ctx.baseUrl, `/faktury/${found.id}`),
    };
  },
  text: (o) => {
    const status = I.statuses[o.status];
    const type = (I.types as Record<string, string>)[o.type] ?? o.type;
    const kinds = I.kinds as Record<string, string>;
    const optional = (label: string, value: string) => (value ? [quoted(label, value)] : []);
    return [
      I.header(o.number ? quoted(T.numberLabel, o.number) : T.noNumber, status, type),
      quoted(I.customer, o.customer.name),
      I.dates(o.issueDate ?? "–", o.dueDate ?? "–", o.taxableDate ?? "–"),
      ...o.lines.map((line) =>
        I.line(
          quoted(I.lineLabel(line.position + 1), line.name),
          quantityText(line.quantityMilli),
          quoted(T.unitLabel, line.unit),
          line.unitPrice.formatted,
          line.net.formatted,
        ),
      ),
      I.totals(o.totals.total.formatted, o.totals.paid.formatted, o.totals.remaining.formatted),
      ...(o.payments.length > 0
        ? [
            I.payments,
            ...o.payments.map((entry) =>
              I.payment(entry.paidOn, entry.amount.formatted, kinds[entry.kind] ?? entry.kind),
            ),
          ]
        : []),
      ...optional(I.note, o.note),
      ...optional(I.textBefore, o.textBefore),
      ...optional(I.textAfter, o.textAfter),
      ...optional(I.reference, o.reference),
      ...optional(I.orderRef, o.orderRef),
      ...(o.tags.length > 0 ? [quoted(I.tags, o.tags.join(", "))] : []),
      o.link,
    ].join("\n");
  },
});
