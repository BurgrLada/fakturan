import { z } from "zod";
import type { TemplateDocument, TemplateLine } from "@/lib/invoice-template";
import { levelAtLeast, type McpLevel } from "@/lib/mcp-settings";
import { isCalendarDate } from "@/lib/number-format";
import {
  ISSUE_RULES,
  RECURRENCE_FREQUENCIES,
  RECURRING_MODES,
  type RecurringMode,
} from "@/lib/recurrence";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quantityText, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { getCustomer } from "../../services/customers";
import { MAX_DOCUMENT_TEXT, newDraftDefaults } from "../../services/invoices";
import { getPreferences } from "../../services/preferences";
import {
  deleteRecurring,
  getRecurring,
  listPlanInvoices,
  listRecurring,
  listRuns,
  previewRecurring,
  recurringFromTemplate,
  saveRecurring,
  type RecurringInput,
} from "../../services/recurring";
import { pauseRecurring, resolveMissed, resumeRecurring } from "../../services/recurring-run";
import { documentInput, lineOf } from "./create-draft";

const T = TEXTS.mcp.recurring;
const W = TEXTS.recurring;
// Lists are capped at 50 rows (MCP-075).
const PAGE_SIZE = 50;

const id = (description: string) => z.string().min(1).max(100).describe(description);
const day = (description: string) =>
  z.string().refine(isCalendarDate, TEXTS.mcp.create.date).describe(description);

const planLink = (ctx: ToolContext, planId: string) =>
  appLink(ctx.baseUrl, `/pravidelne/${planId}`);

// Another account's plan is not seen here, as a missing one (MCP-074).
type Plan = NonNullable<ReturnType<typeof getRecurring>>;

function ownPlan(ctx: ToolContext, planId: string): Plan {
  const row = getRecurring(ctx.ownerId, planId);
  if (!row) throw new McpToolError(W.validation.notFound);
  return row;
}

// The fields a plan is made of; with an id, what is left out stays as stored.
const planFields = {
  id: id(T.id).optional(),
  name: z.string().max(100).describe(T.name).optional(),
  customerId: z.string().min(1).max(100).nullable().describe(T.customerId).optional(),
  lines: documentInput.lines.describe(T.lines).optional(),
  note: z.string().max(MAX_DOCUMENT_TEXT).describe(T.note).optional(),
  dueDays: z.number().int().describe(T.dueDays).optional(),
  frequency: z.enum(RECURRENCE_FREQUENCIES).describe(T.frequency).optional(),
  every: z.number().int().describe(T.every).optional(),
  issueRule: z.enum(ISSUE_RULES).describe(T.issueRule).optional(),
  issueDay: z.number().int().nullable().describe(T.issueDay).optional(),
  startsOn: day(T.startsOn).optional(),
  endsOn: day(T.endsOn).nullable().optional(),
  maxCount: z.number().int().nullable().describe(T.maxCount).optional(),
  periodOffset: z.number().int().describe(T.periodOffset).optional(),
  mode: z.enum(RECURRING_MODES).describe(T.mode).optional(),
  notifyDaysBefore: z.number().int().nullable().describe(T.notifyDaysBefore).optional(),
};
const planInput = z.strictObject(planFields);
type PlanArgs = z.infer<typeof planInput>;

// A new plan starts from what the web's new-plan form shows (pravidelne/nova).
function newDocument(ctx: ToolContext): TemplateDocument {
  const defaults = newDraftDefaults(ctx.ownerId, null);
  return {
    type: "invoice",
    bankAccountId: defaults.bankAccountId ?? null,
    dueDays: getPreferences(ctx.ownerId).dueDays,
    language: defaults.language,
    currency: defaults.currency,
    paymentMethod: defaults.paymentMethod,
    orderRef: "",
    reference: "",
    textBefore: defaults.textBefore,
    textAfter: defaults.textAfter,
    note: defaults.note,
    discountKind: "none",
    discountValue: 0,
    rounding: defaults.rounding,
    appearance: defaults.appearance,
    lines: [],
  };
}

const pick = <V>(given: V | undefined, kept: V): V => (given === undefined ? kept : given);

// The whole plan goes to the service as the web's form sends it; the service validates it.
function recurringInputOf(ctx: ToolContext, args: PlanArgs): RecurringInput {
  const stored = args.id ? ownPlan(ctx, args.id) : null;
  const document = stored?.document ?? newDocument(ctx);
  const unit = getPreferences(ctx.ownerId).unit;
  const lines: TemplateLine[] = args.lines
    ? args.lines.map((line) => lineOf(ctx.ownerId, line, document.currency, unit))
    : document.lines;
  return {
    id: stored?.id,
    name: pick(args.name, stored?.name ?? ""),
    customerId: pick(args.customerId, stored?.customerId ?? null),
    document: {
      ...document,
      dueDays: pick(args.dueDays, document.dueDays),
      note: pick(args.note, document.note),
      lines,
    },
    frequency: pick(args.frequency, stored?.frequency ?? "monthly"),
    every: pick(args.every, stored?.every ?? 1),
    issueRule: pick(args.issueRule, stored?.issueRule ?? "day"),
    issueDay: pick(args.issueDay, stored ? stored.issueDay : Number(ctx.today.slice(8))),
    startsOn: pick(args.startsOn, stored?.startsOn ?? ctx.today),
    endsOn: pick(args.endsOn, stored?.endsOn ?? null),
    maxCount: pick(args.maxCount, stored?.maxCount ?? null),
    periodOffset: pick(args.periodOffset, stored?.periodOffset ?? 0),
    mode: pick(args.mode, stored?.mode ?? "draft"),
    notifyDaysBefore: pick(args.notifyDaysBefore, stored?.notifyDaysBefore ?? null),
  };
}

// A plan that issues or sends on its own needs level 4, as does changing one (MCP-051).
const modeLevel = (mode: RecurringMode): McpLevel =>
  mode === "draft" ? "accounting" : "issue_send";
const higher = (a: McpLevel, b: McpLevel): McpLevel => (levelAtLeast(a, b) ? a : b);

const planOutput = z.object({
  id: z.string(),
  name: z.string(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  status: z.string(),
  mode: z.string(),
  frequency: z.string(),
  every: z.number().int(),
  issueRule: z.string(),
  issueDay: z.number().int().nullable(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  maxCount: z.number().int().nullable(),
  periodOffset: z.number().int(),
  notifyDaysBefore: z.number().int().nullable(),
  nextIssueDate: z.string().nullable(),
  currency: z.string(),
  dueDays: z.number().int(),
  note: z.string(),
  lines: z.array(z.object({ name: z.string(), quantity: z.string(), unitPrice: moneySchema })),
  link: z.string(),
});
type PlanOutput = z.infer<typeof planOutput>;

function planOf(ctx: ToolContext, planId: string): PlanOutput {
  const plan = ownPlan(ctx, planId);
  const head = listRecurring(ctx.ownerId).find((row) => row.id === planId);
  const { document } = plan;
  return {
    id: plan.id,
    name: plan.name,
    customerId: plan.customerId,
    customerName: plan.customerId
      ? (getCustomer(ctx.ownerId, plan.customerId)?.name ?? null)
      : null,
    status: plan.status,
    mode: plan.mode,
    frequency: plan.frequency,
    every: plan.every,
    issueRule: plan.issueRule,
    issueDay: plan.issueDay,
    startsOn: plan.startsOn,
    endsOn: plan.endsOn,
    maxCount: plan.maxCount,
    periodOffset: plan.periodOffset,
    notifyDaysBefore: plan.notifyDaysBefore,
    nextIssueDate: head?.nextIssueDate ?? null,
    currency: document.currency,
    dueDays: document.dueDays,
    note: document.note,
    lines: document.lines.map((line) => ({
      name: line.name,
      quantity: quantityText(line.quantityMilli),
      unitPrice: money(line.unitPriceMinor, document.currency),
    })),
    link: planLink(ctx, plan.id),
  };
}

const statusLabel = (status: string) => (W.statuses as Record<string, string>)[status] ?? status;
const modeLabel = (mode: string) => (W.modes as Record<string, string>)[mode] ?? mode;

// Plan names and line texts are data, never instructions (MCP-033).
const planText = (headline?: string) => (o: PlanOutput) =>
  [
    ...(headline ? [headline] : []),
    quoted(T.label, o.name),
    quoted(T.customerLabel, o.customerName ?? T.noCustomer),
    T.plan(statusLabel(o.status), modeLabel(o.mode), o.frequency, o.nextIssueDate ?? T.noNext),
    ...o.lines.map((line, i) =>
      T.line(quoted(T.lineLabel(i + 1), line.name), line.quantity, line.unitPrice.formatted),
    ),
    ...(o.note ? [quoted(T.noteLabel, o.note)] : []),
    TEXTS.mcp.create.link(o.link),
  ].join("\n");

export const listRecurringTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({
    more: z.boolean(),
    plans: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        customerName: z.string().nullable(),
        status: z.string(),
        mode: z.string(),
        nextIssueDate: z.string().nullable(),
        link: z.string(),
      }),
    ),
  }),
  fieldLabels: T.fields,
  run: (ctx) => {
    const rows = listRecurring(ctx.ownerId);
    return {
      more: rows.length > PAGE_SIZE,
      plans: rows.slice(0, PAGE_SIZE).map((row) => ({
        id: row.id,
        name: row.name,
        customerName: row.customerName,
        status: row.status,
        mode: row.mode,
        nextIssueDate: row.nextIssueDate,
        link: planLink(ctx, row.id),
      })),
    };
  },
  text: (o) =>
    o.plans.length === 0
      ? T.empty
      : [
          T.heading(o.plans.length, o.more),
          ...o.plans.map((row) =>
            T.row(
              row.id,
              quoted(T.label, row.name),
              statusLabel(row.status),
              modeLabel(row.mode),
              row.nextIssueDate ?? T.noNext,
              row.link,
            ),
          ),
        ].join("\n"),
});

export const getRecurringTool = defineTool({
  name: T.get.name,
  title: T.get.title,
  description: T.get.description,
  level: "read",
  input: z.strictObject({ id: id(T.id) }),
  output: planOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => planOf(ctx, args.id),
  text: planText(),
});

export const listRecurringRunsTool = defineTool({
  name: T.runs.name,
  title: T.runs.title,
  description: T.runs.description,
  level: "read",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({
    runs: z.array(
      z.object({
        id: z.string(),
        plannedDate: z.string(),
        periodFrom: z.string(),
        periodTo: z.string(),
        status: z.string(),
        invoiceId: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
      }),
    ),
  }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    ownPlan(ctx, args.id);
    return {
      runs: listRuns(ctx.ownerId, args.id)
        .slice(0, PAGE_SIZE)
        .map((run) => ({
          id: run.id,
          plannedDate: run.plannedDate,
          periodFrom: run.periodFrom,
          periodTo: run.periodTo,
          status: run.status,
          invoiceId: run.invoiceId,
          invoiceNumber: run.invoiceNumber,
        })),
    };
  },
  text: (o) =>
    o.runs.length === 0
      ? T.runs.empty
      : o.runs
          .map((run) => T.runs.row(run.id, run.plannedDate, run.status, run.invoiceNumber ?? ""))
          .join("\n"),
});

export const listPlanInvoicesTool = defineTool({
  name: T.invoices.name,
  title: T.invoices.title,
  description: T.invoices.description,
  level: "read",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({
    invoices: z.array(
      z.object({
        id: z.string(),
        number: z.string().nullable(),
        status: z.string(),
        issueDate: z.string().nullable(),
        total: moneySchema,
        link: z.string(),
      }),
    ),
  }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    ownPlan(ctx, args.id);
    return {
      invoices: listPlanInvoices(ctx.ownerId, args.id)
        .slice(0, PAGE_SIZE)
        .map((row) => ({
          id: row.id,
          number: row.number,
          status: row.status,
          issueDate: row.issueDate,
          total: money(row.totalMinor, row.currency),
          link: appLink(ctx.baseUrl, `/faktury/${row.id}`),
        })),
    };
  },
  text: (o) =>
    o.invoices.length === 0
      ? T.invoices.empty
      : o.invoices
          .map((row) =>
            T.invoices.row(
              row.id,
              row.number ?? T.invoices.noNumber,
              row.status,
              row.total.formatted,
            ),
          )
          .join("\n"),
});

export const previewRecurringTool = defineTool({
  name: T.preview.name,
  title: T.preview.title,
  description: T.preview.description,
  level: "read",
  input: planInput,
  output: z.object({
    occurrences: z.array(z.object({ issueDate: z.string(), from: z.string(), to: z.string() })),
  }),
  fieldLabels: T.fields,
  run: (ctx, args) => ({
    occurrences: previewRecurring(ctx.ownerId, recurringInputOf(ctx, args)).map((row) => ({
      issueDate: row.issueDate,
      from: row.billedPeriod.from,
      to: row.billedPeriod.to,
    })),
  }),
  text: (o) =>
    [
      T.preview.heading,
      ...o.occurrences.map((row) => T.preview.row(row.issueDate, row.from, row.to)),
    ].join("\n"),
});

export const saveRecurringTool = defineTool({
  name: T.save.name,
  title: T.save.title,
  description: T.save.description,
  level: "accounting",
  // The higher of the wanted mode and the stored one; a person confirms send in the web (MCP-051).
  levelFor: (ctx, args) => {
    const stored = args.id ? getRecurring(ctx.ownerId, args.id)?.mode : undefined;
    const wanted = modeLevel(args.mode ?? stored ?? "draft");
    return stored ? higher(wanted, modeLevel(stored)) : wanted;
  },
  input: planInput,
  output: planOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => planOf(ctx, saveRecurring(ctx.actor, recurringInputOf(ctx, args)).id),
  text: planText(T.save.done),
});

const stateOutput = z.object({ id: z.string(), status: z.string(), link: z.string() });
const stateOf = (ctx: ToolContext, planId: string) => ({
  id: planId,
  status: ownPlan(ctx, planId).status,
  link: planLink(ctx, planId),
});
const stateText = (headline: string) => (o: z.infer<typeof stateOutput>) =>
  [headline, TEXTS.mcp.create.link(o.link)].join("\n");

export const pauseRecurringTool = defineTool({
  name: T.pause.name,
  title: T.pause.title,
  description: T.pause.description,
  level: "accounting",
  input: z.strictObject({ id: id(T.id) }),
  output: stateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    pauseRecurring(ctx.actor, args.id);
    return stateOf(ctx, args.id);
  },
  text: stateText(T.pause.done),
});

export const resumeRecurringTool = defineTool({
  name: T.resume.name,
  title: T.resume.title,
  description: T.resume.description,
  // A resumed plan may issue on its own, whatever its mode now (spec 5.5).
  level: "issue_send",
  input: z.strictObject({ id: id(T.id) }),
  output: stateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    resumeRecurring(ctx.actor, args.id);
    return stateOf(ctx, args.id);
  },
  text: stateText(T.resume.done),
});

export const resolveMissedRunTool = defineTool({
  name: T.missed.name,
  title: T.missed.title,
  description: T.missed.description,
  level: "accounting",
  input: z.strictObject({
    runId: id(T.missed.runId),
    action: z.enum(["draft", "skip"]).describe(T.missed.action),
  }),
  output: z.object({
    runId: z.string(),
    invoiceId: z.string().nullable(),
    link: z.string().nullable(),
  }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const { invoiceId } = resolveMissed(ctx.actor, args.runId, args.action);
    return {
      runId: args.runId,
      invoiceId,
      link: invoiceId ? appLink(ctx.baseUrl, `/faktury/${invoiceId}/upravit`) : null,
    };
  },
  text: (o) =>
    o.invoiceId ? [T.missed.drafted, TEXTS.mcp.create.link(o.link!)].join("\n") : T.missed.skipped,
});

export const recurringFromTemplateTool = defineTool({
  name: T.fromTemplate.name,
  title: T.fromTemplate.title,
  description: T.fromTemplate.description,
  level: "accounting",
  input: z.strictObject({ id: id(T.fromTemplate.id) }),
  output: planOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => planOf(ctx, recurringFromTemplate(ctx.actor, args.id).id),
  text: planText(T.save.done),
});

export const deleteRecurringTool = defineTool({
  name: T.delete.name,
  title: T.delete.title,
  description: T.delete.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({ id: z.string() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteRecurring(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.delete.done,
});

export const RECURRING_TOOLS = [
  listRecurringTool,
  getRecurringTool,
  listRecurringRunsTool,
  listPlanInvoicesTool,
  previewRecurringTool,
  saveRecurringTool,
  pauseRecurringTool,
  resumeRecurringTool,
  resolveMissedRunTool,
  recurringFromTemplateTool,
  deleteRecurringTool,
];
