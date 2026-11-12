import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { formatRate } from "@/lib/invoice-form";
import { isCalendarDate } from "@/lib/number-format";
import {
  COMPARE_MODES,
  COMPARE_PARAM,
  parseReportFilter,
  parseTaxFilter,
  PERIOD_PARAM,
  TAX_BASES,
  TAX_BASIS_PARAM,
  FIRST_TAX_YEAR,
} from "@/lib/report-filter";
import { PERIOD_TOKENS } from "@/lib/report-period";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool } from "../tool";
import { reportBundle } from "../../services/reports";
import { taxOverview } from "../../services/tax-report";
import { loadRate } from "../../services/exchange-rates";

const T = TEXTS.mcp.insights;
const R = T.report;
const READ = TEXTS.mcp.read;
const MAX_ROWS = 50;
// The web reads this value of "importovane" as "leave imported documents out".
const EXCLUDE_IMPORTED = "ne";

const date = (description: string) =>
  z
    .string(READ.dateFormat)
    .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value), READ.dateFormat)
    .describe(description);

const range = z.object({ from: z.string(), to: z.string() });
const ranked = z.object({
  kind: z.enum(["row", "others", "adjustment"]),
  name: z.string(),
  amount: moneySchema,
});
const summary = z.object({
  invoiced: moneySchema,
  income: moneySchema,
  outstanding: moneySchema,
  overdue: moneySchema,
  advanceOpen: moneySchema,
});
const series = z.array(z.object({ key: z.string(), amount: moneySchema }));

type Bundle = ReturnType<typeof reportBundle>;
type Summary = Bundle["summary"];

// Documents without a CNB rate are named only by count; the web shows the same note (R-9).
const missing = (s: Summary) => Math.max(0, ...Object.values(s.unconverted).map((u) => u.count));

export const getReportTool = defineTool({
  name: R.name,
  title: R.title,
  description: R.description,
  level: "read",
  input: z.strictObject({
    period: z.enum(PERIOD_TOKENS).optional().describe(R.period),
    from: date(R.from).optional(),
    to: date(R.to).optional(),
    compare: z.enum(COMPARE_MODES).optional().describe(R.compare),
    currency: z.enum(CURRENCIES).optional().describe(R.currency),
    includeImported: z.boolean().optional().describe(R.includeImported),
  }),
  output: z.object({
    range,
    previousRange: range,
    compare: z.enum(COMPARE_MODES),
    currency: z.string(),
    unit: z.string(),
    summary,
    previous: summary,
    unconvertedCount: z.number().int(),
    invoiced: series,
    income: series,
    previousInvoiced: series,
    previousIncome: series,
    aging: z.object({
      current: moneySchema,
      days0to30: moneySchema,
      days31to60: moneySchema,
      days61to90: moneySchema,
      days90plus: moneySchema,
    }),
    customers: z.array(ranked),
    items: z.array(ranked),
    currencies: z.array(z.object({ currency: z.string(), amount: moneySchema, czk: moneySchema })),
    paymentDays: z.object({ averageDays: z.number().nullable(), count: z.number().int() }),
    limits: z.object({
      year: z.number().int(),
      basis: z.string(),
      states: z.array(
        z.object({
          key: z.string(),
          limit: moneySchema,
          turnover: moneySchema,
          watched: z.boolean(),
          percent: z.number().optional(),
          level: z.string().optional(),
        }),
      ),
    }),
    forecast: z.array(z.object({ month: z.string(), amounts: z.record(z.string(), moneySchema) })),
    link: z.string(),
  }),
  fieldLabels: T.fields,
  run: (ctx, input) => {
    if (input.period && (input.from || input.to)) throw new McpToolError(R.bothPeriods);
    const custom = input.from || input.to;
    const from = input.from ?? `${ctx.today.slice(0, 4)}-01-01`;
    const to = input.to ?? ctx.today;
    if (custom && from > to) throw new McpToolError(READ.periodReversed);
    // The same reading of the filter as the Přehledy page, from the same parameters.
    const { tab: _tab, ...filter } = parseReportFilter(
      {
        ...(input.period && { obdobi: PERIOD_PARAM[input.period] }),
        ...(custom && { od: from, do: to }),
        ...(input.compare && { porovnani: COMPARE_PARAM[input.compare] }),
        ...(input.currency && { mena: input.currency }),
        ...(input.includeImported === false && { importovane: EXCLUDE_IMPORTED }),
      },
      ctx.today,
    );
    const b = reportBundle(ctx.ownerId, filter, ctx.today);
    const m = (minor: number) => money(minor, b.currency);
    const sum = (s: Summary) => ({
      invoiced: m(s.invoicedMinor),
      income: m(s.incomeMinor),
      outstanding: m(s.outstandingMinor),
      overdue: m(s.overdueMinor),
      advanceOpen: m(s.advanceOpenMinor),
    });
    const points = (s: Bundle["invoiced"]) =>
      s.points.map((p) => ({ key: p.key, amount: m(p.amountMinor) }));
    const rank = (r: Bundle["customers"]) =>
      r.rows.map((row) => ({ kind: row.kind, name: row.name, amount: m(row.amountMinor) }));
    const { current, days0to30, days31to60, days61to90, days90plus } = b.aging.bands;
    return {
      range: b.range,
      previousRange: b.previousRange,
      compare: b.compare,
      currency: b.currency,
      unit: b.unit,
      summary: sum(b.summary),
      previous: sum(b.previous),
      unconvertedCount: missing(b.summary),
      invoiced: points(b.invoiced),
      income: points(b.income),
      previousInvoiced: points(b.previousInvoiced),
      previousIncome: points(b.previousIncome),
      aging: {
        current: m(current),
        days0to30: m(days0to30),
        days31to60: m(days31to60),
        days61to90: m(days61to90),
        days90plus: m(days90plus),
      },
      customers: rank(b.customers),
      items: rank(b.items),
      currencies: b.currencies.rows.map((row) => ({
        currency: row.currency,
        amount: money(row.amountMinor, row.currency),
        czk: money(row.czkMinor, "CZK"),
      })),
      paymentDays: b.paymentDays,
      // Turnover limits are statutory amounts in CZK whatever currency the report shows.
      limits: {
        year: b.limits.year,
        basis: b.limits.basis,
        states: b.limits.states.map((state) => ({
          key: state.key,
          limit: money(state.limitMinor, "CZK"),
          turnover: money(state.turnoverMinor, "CZK"),
          watched: state.watched,
          ...(state.watched && { percent: state.percent, level: state.level }),
        })),
      },
      forecast: b.forecast.map(({ month, unconverted: _u, ...amounts }) => ({
        month,
        amounts: Object.fromEntries(
          Object.entries(amounts).map(([key, minor]) => [key, m(minor as number)]),
        ),
      })),
      link: appLink(ctx.baseUrl, "/prehledy"),
    };
  },
  text: (o) => {
    const s = o.summary;
    const rows = (heading: string, list: typeof o.customers) =>
      list.length === 0
        ? []
        : [
            heading,
            ...list.map((row) =>
              R.rankRow(
                row.kind === "row"
                  ? quoted(R.customers, row.name)
                  : row.kind === "others"
                    ? R.others
                    : R.adjustment,
                row.amount.formatted,
              ),
            ),
          ];
    const a = o.aging;
    return [
      R.heading(o.range.from, o.range.to, o.currency),
      R.summary(
        s.invoiced.formatted,
        s.income.formatted,
        s.outstanding.formatted,
        s.overdue.formatted,
        s.advanceOpen.formatted,
      ),
      R.previous(o.previous.invoiced.formatted, o.previous.income.formatted),
      ...(o.unconvertedCount > 0 ? [R.unconverted(o.unconvertedCount)] : []),
      R.aging(
        a.current.formatted,
        a.days0to30.formatted,
        a.days31to60.formatted,
        a.days61to90.formatted,
        a.days90plus.formatted,
      ),
      ...rows(R.customers, o.customers),
      ...rows(R.items, o.items),
      R.paymentDays(o.paymentDays.averageDays, o.paymentDays.count),
      ...o.limits.states.map((state) =>
        R.limit(state.key, state.turnover.formatted, state.limit.formatted),
      ),
      R.link(o.link),
    ].join("\n");
  },
});

export const getTaxOverviewTool = defineTool({
  name: T.tax.name,
  title: T.tax.title,
  description: T.tax.description,
  level: "read",
  input: z.strictObject({
    year: z.number().int().min(FIRST_TAX_YEAR).max(9999).optional().describe(T.tax.year),
    basis: z.enum(TAX_BASES).optional().describe(T.tax.basis),
  }),
  output: z.object({
    year: z.number().int(),
    basis: z.enum(TAX_BASES),
    total: moneySchema,
    linesCount: z.number().int(),
    lines: z.array(
      z.object({
        invoiceId: z.string(),
        date: z.string(),
        number: z.string(),
        type: z.string(),
        customer: z.string(),
        amount: moneySchema,
        czk: moneySchema.nullable(),
        estimated: z.boolean(),
      }),
    ),
    unpaidTotal: moneySchema,
    unpaidCount: z.number().int(),
    unpaid: z.array(
      z.object({
        invoiceId: z.string(),
        number: z.string(),
        type: z.string(),
        issueDate: z.string(),
        dueDate: z.string().nullable(),
        customer: z.string(),
        due: moneySchema,
        czk: moneySchema.nullable(),
      }),
    ),
    estimatedCount: z.number().int(),
    link: z.string(),
  }),
  fieldLabels: T.fields,
  run: (ctx, input) => {
    const filter = parseTaxFilter(
      {
        ...(input.year !== undefined && { rok: String(input.year) }),
        ...(input.basis && { zaklad: TAX_BASIS_PARAM[input.basis] }),
      },
      ctx.today,
    );
    const tax = taxOverview(ctx.ownerId, filter, ctx.today);
    return {
      year: tax.year,
      basis: tax.basis,
      total: money(tax.totalCzkMinor, "CZK"),
      linesCount: tax.lines.length,
      lines: tax.lines.slice(0, MAX_ROWS).map((line) => ({
        invoiceId: line.invoiceId,
        date: line.date,
        number: line.number,
        type: line.type,
        customer: line.customer,
        amount: money(line.amountMinor, line.currency),
        czk: line.czkMinor === null ? null : money(line.czkMinor, "CZK"),
        estimated: line.estimated,
      })),
      unpaidTotal: money(tax.unpaidCzkMinor, "CZK"),
      unpaidCount: tax.unpaid.length,
      unpaid: tax.unpaid.slice(0, MAX_ROWS).map((row) => ({
        invoiceId: row.invoiceId,
        number: row.number,
        type: row.type,
        issueDate: row.issueDate,
        dueDate: row.dueDate,
        customer: row.customer,
        due: money(row.dueMinor, row.currency),
        czk: row.czkMinor === null ? null : money(row.czkMinor, "CZK"),
      })),
      estimatedCount: tax.estimated.count,
      link: appLink(ctx.baseUrl, "/prehledy/dane"),
    };
  },
  text: (o) => {
    const t = T.tax;
    return [
      t.heading(o.year, t.bases[o.basis], o.total.formatted),
      ...o.lines.map((line) =>
        t.line(
          line.date,
          line.number,
          quoted(t.customer, line.customer),
          (line.czk ?? line.amount).formatted,
        ),
      ),
      ...(o.linesCount > o.lines.length ? [t.more(o.lines.length, o.linesCount)] : []),
      t.unpaid(o.unpaidCount, o.unpaidTotal.formatted),
      ...(o.estimatedCount > 0 ? [t.estimated(o.estimatedCount)] : []),
      R.link(o.link),
    ].join("\n");
  },
});

const X = T.rate;
const RATE_SOURCES = ["cnb", "last_known", "fixed", "import"] as const;

export const getExchangeRateTool = defineTool({
  name: X.name,
  title: X.title,
  description: X.description,
  level: "read",
  input: z.strictObject({
    currency: z.enum(CURRENCIES).describe(X.currency),
    date: date(X.date),
  }),
  output: z.object({
    currency: z.string(),
    date: z.string(),
    rate: z.string().nullable(),
    source: z.enum(RATE_SOURCES).nullable(),
    listDate: z.string().nullable(),
    reference: z.string().nullable(),
  }),
  fieldLabels: T.fields,
  // Like the form's rate loader it may store a fetched CNB list; nothing of the account changes.
  run: async (ctx, { currency, date: day }) => {
    const found = await loadRate(ctx.actor, { currency, date: day });
    return {
      currency,
      date: day,
      rate: found ? formatRate(found.rateMicros) : null,
      source: found?.source ?? null,
      listDate: found?.listDate ?? null,
      reference: found && found.reference !== null ? formatRate(found.reference) : null,
    };
  },
  text: (o) =>
    o.rate === null || o.source === null
      ? X.none(o.currency, o.date)
      : X.found(o.currency, o.rate, X.sources[o.source], o.listDate ?? ""),
});

export const REPORT_TOOLS = [getReportTool, getTaxOverviewTool, getExchangeRateTool];
