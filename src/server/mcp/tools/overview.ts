import { z } from "zod";
import { isCalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { money, moneySchema } from "../format";
import { defineTool } from "../tool";
import { reportCounts, reportSummary } from "../../services/reports";
import { invoiceSummary } from "../../services/invoices";
import type { Currency } from "@/lib/currency";

const T = TEXTS.mcp.read;

const date = (description: string) =>
  z
    .string(T.dateFormat)
    .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value), T.dateFormat)
    .describe(description);

const input = z.strictObject({
  from: date(T.overview.from).optional(),
  to: date(T.overview.to).optional(),
});

const totals = z.object({
  invoiced: moneySchema,
  income: moneySchema,
  outstanding: moneySchema,
  overdue: moneySchema,
  // Open advance invoices: reports keep them out of the other sums (ADV-007).
  advanceOpen: moneySchema,
});

const output = totals.extend({
  period: z.object({ from: z.string(), to: z.string() }),
  counts: z.object({
    issued: z.number().int(),
    unpaid: z.number().int(),
    overdue: z.number().int(),
  }),
  // Documents without a CNB rate yet, left out of the CZK sums.
  unconvertedCount: z.number().int(),
  byCurrency: z.array(totals.extend({ currency: z.string() })),
});

export const getOverviewTool = defineTool({
  name: T.overview.name,
  title: T.overview.title,
  description: T.overview.description,
  level: "read",
  input,
  output,
  run: (ctx, { from, to }) => {
    const range = { from: from ?? `${ctx.today.slice(0, 4)}-01-01`, to: to ?? ctx.today };
    if (range.from > range.to) throw new McpToolError(T.periodReversed);
    const filter = { range, includeExternal: true };
    const summary = reportSummary(ctx.ownerId, filter, ctx.today);
    const row = (s: typeof summary, currency: string) => ({
      invoiced: money(s.invoicedMinor, currency),
      income: money(s.incomeMinor, currency),
      outstanding: money(s.outstandingMinor, currency),
      overdue: money(s.overdueMinor, currency),
      advanceOpen: money(s.advanceOpenMinor, currency),
    });
    const byCurrency = invoiceSummary(ctx.ownerId, {})
      .map((entry) => entry.currency as Currency)
      .map((currency) => ({
        currency,
        ...row(reportSummary(ctx.ownerId, { ...filter, currency }, ctx.today), currency),
      }))
      .filter((entry) =>
        [entry.invoiced, entry.income, entry.outstanding, entry.overdue, entry.advanceOpen].some(
          (m) => m.amount !== 0,
        ),
      );
    return {
      period: range,
      ...row(summary, "CZK"),
      counts: reportCounts(ctx.ownerId, filter, ctx.today),
      unconvertedCount: Math.max(...Object.values(summary.unconverted).map((u) => u.count)),
      byCurrency,
    };
  },
  text: (o) => {
    const t = T.overview;
    return [
      t.heading(o.period.from, o.period.to),
      t.invoiced(o.invoiced.formatted, o.counts.issued),
      t.income(o.income.formatted),
      t.outstanding(o.outstanding.formatted, o.counts.unpaid),
      t.overdue(o.overdue.formatted, o.counts.overdue),
      t.advanceOpen(o.advanceOpen.formatted),
      ...(o.unconvertedCount > 0 ? [t.unconverted(o.unconvertedCount)] : []),
      ...(o.byCurrency.length > 0
        ? [
            t.byCurrency,
            ...o.byCurrency.map((c) =>
              t.currencyRow(
                c.currency,
                c.invoiced.formatted,
                c.income.formatted,
                c.outstanding.formatted,
                c.overdue.formatted,
                c.advanceOpen.formatted,
              ),
            ),
          ]
        : []),
    ].join("\n");
  },
});
