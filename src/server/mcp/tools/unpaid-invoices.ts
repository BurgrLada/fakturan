import { z } from "zod";
import { INVOICE_STATUSES } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool } from "../tool";
import { getCustomer } from "../../services/customers";
import { listUnpaidInvoices } from "../../services/invoices";

const T = TEXTS.mcp.read;
const PAGE_SIZE = 25;

const input = z.strictObject({
  overdueOnly: z.boolean().describe(T.unpaid.overdueOnly).optional(),
  customerId: z.string().min(1).max(100).describe(T.unpaid.customerId).optional(),
  page: z.number().int().min(1).max(10_000).describe(T.unpaid.page).optional(),
});

const output = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  hasNext: z.boolean(),
  invoices: z.array(
    z.object({
      id: z.string(),
      number: z.string().nullable(),
      status: z.enum(INVOICE_STATUSES),
      customerId: z.string().nullable(),
      customerName: z.string(),
      issueDate: z.string().nullable(),
      dueDate: z.string().nullable(),
      overdue: z.boolean(),
      daysOverdue: z.number().int(),
      total: moneySchema,
      remaining: moneySchema,
      link: z.string(),
    }),
  ),
});

export const listUnpaidInvoicesTool = defineTool({
  name: T.unpaid.name,
  title: T.unpaid.title,
  description: T.unpaid.description,
  capability: "read",
  input,
  output,
  run: (ctx, { overdueOnly, customerId, page }) => {
    // The list service ignores an id that is not the account's, which would show every customer.
    if (customerId && !getCustomer(ctx.ownerId, customerId)) {
      throw new McpToolError(T.customerNotFound);
    }
    const result = listUnpaidInvoices(ctx.ownerId, {
      overdueOnly,
      customerId,
      page,
      pageSize: PAGE_SIZE,
    });
    return {
      page: result.page,
      pageSize: result.pageSize,
      hasNext: result.hasNext,
      invoices: result.rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        customerId: row.customerId,
        customerName: row.customerName,
        issueDate: row.issueDate,
        dueDate: row.dueDate,
        overdue: row.overdue,
        daysOverdue: row.daysOverdue,
        total: money(row.totalMinor, row.currency),
        remaining: money(row.remainingMinor, row.currency),
        link: appLink(ctx.baseUrl, `/faktury/${row.id}`),
      })),
    };
  },
  text: (o) =>
    o.invoices.length === 0
      ? T.noUnpaid
      : [
          T.unpaid.heading(o.invoices.length, o.page, o.hasNext),
          ...o.invoices.map((row) =>
            T.unpaid.row(
              row.number ? quoted(T.numberLabel, row.number) : T.noNumber,
              quoted(T.invoice.customer, row.customerName),
              row.dueDate ?? "–",
              row.remaining.formatted,
              row.daysOverdue,
              row.link,
            ),
          ),
        ].join("\n"),
});
