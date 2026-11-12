import { z } from "zod";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import { isCalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { createCreditNoteWithSeries } from "../../services/credit-notes";
import {
  cancelInvoice,
  deleteImported,
  issueInvoice,
  markSent,
  markSentMany,
  NotIssuableError,
  restoreInvoice,
} from "../../services/invoice-lifecycle";
import {
  getVersion,
  refreshCustomerSnapshot,
  restoreVersion,
  updateIssuedWithTags,
  type EditResult,
} from "../../services/invoice-versions";
import { deleteDraft, getInvoice, MAX_DOCUMENT_TEXT } from "../../services/invoices";
import { getPreferences } from "../../services/preferences";
import { setPartialReminders, setRemindersOff, snoozeReminders } from "../../services/reminders";
import { documentInput, draftOfId, draftOutput, draftText, lineOf } from "./create-draft";

const T = TEXTS.mcp.lifecycle;
const R = TEXTS.mcp.read;

const id = (description: string) => z.string().min(1).max(100).describe(description);
const revision = z.number().int().describe(T.revision);

const state = z.object({
  id: z.string(),
  number: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  // Send it back with the next operation on the invoice (MCP-072).
  revision: z.number().int(),
  link: z.string(),
});
type State = z.infer<typeof state>;

// The services refuse another account's invoice as a missing one (MCP-074), so it exists here.
function stateOf(ctx: ToolContext, invoiceId: string): State {
  const row = getInvoice(ctx.ownerId, invoiceId)!;
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    status: row.status,
    revision: row.revision,
    link: appLink(ctx.baseUrl, `/faktury/${row.id}`),
  };
}

const statusLabel = (status: string) =>
  (R.invoice.statuses as Record<string, string>)[status] ?? status;

const stateText = (headline: string) => (o: State) =>
  [
    headline,
    T.state(o.number ?? R.noNumber, statusLabel(o.status), o.revision),
    TEXTS.mcp.create.link(o.link),
  ].join("\n");

// A tool that changes one invoice and answers with its state.
function onInvoice<Extra extends z.ZodRawShape>(
  texts: { name: string; title: string; description: string; done: string },
  level: "accounting" | "full",
  extra: Extra,
  action: (ctx: ToolContext, args: { id: string } & z.infer<z.ZodObject<Extra>>) => void,
) {
  return defineTool({
    name: texts.name,
    title: texts.title,
    description: texts.description,
    level,
    input: z.strictObject({ id: id(T.id), ...extra }),
    output: state,
    fieldLabels: T.fields,
    run: (ctx, args) => {
      const input = args as { id: string } & z.infer<z.ZodObject<Extra>>;
      action(ctx, input);
      return stateOf(ctx, input.id);
    },
    text: stateText(texts.done),
  });
}

export const markSentTool = onInvoice(T.markSent, "accounting", {}, (ctx, args) =>
  markSent(ctx.actor, args.id),
);

export const markSentManyTool = defineTool({
  name: T.markSentMany.name,
  title: T.markSentMany.title,
  description: T.markSentMany.description,
  level: "accounting",
  input: z.strictObject({
    ids: z.array(id(T.id)).min(1).max(MAX_BULK_DOCUMENTS).describe(T.ids),
  }),
  output: z.object({ done: z.number().int(), skipped: z.number().int() }),
  fieldLabels: T.fields,
  run: (ctx, args) => markSentMany(ctx.actor, args.ids),
  text: (o) => T.markSentMany.done(o.done, o.skipped),
});

export const snoozeRemindersTool = onInvoice(
  T.snooze,
  "accounting",
  {
    until: z
      .string()
      .refine(isCalendarDate, TEXTS.mcp.create.date)
      .nullable()
      .describe(T.snooze.until),
  },
  (ctx, args) => snoozeReminders(ctx.actor, args.id, args.until),
);

export const setRemindersOffTool = onInvoice(
  T.remindersOff,
  "accounting",
  { off: z.boolean().describe(T.remindersOff.off) },
  (ctx, args) => setRemindersOff(ctx.actor, args.id, args.off),
);

export const setPartialRemindersTool = onInvoice(
  T.partial,
  "accounting",
  { on: z.boolean().describe(T.partial.on) },
  (ctx, args) => setPartialReminders(ctx.actor, args.id, args.on),
);

export const issueInvoiceTool = defineTool({
  name: T.issue.name,
  title: T.issue.title,
  description: T.issue.description,
  level: "issue_send",
  input: z.strictObject({
    id: id(T.id),
    revision,
    variableSymbol: z.string().max(10).describe(T.issue.variableSymbol).optional(),
  }),
  output: state,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    try {
      issueInvoice(ctx.actor, args.id, {
        revision: args.revision,
        variableSymbol: args.variableSymbol,
      });
    } catch (error) {
      // The web lists what to fix next to the fields; the assistant gets the same list (MCP-073).
      if (!(error instanceof NotIssuableError)) throw error;
      const lines = error.problems.map((problem) => `- ${problem.message}`);
      throw new McpToolError([T.notIssuable, ...lines].join("\n"), {
        problems: error.problems,
      });
    }
    return stateOf(ctx, args.id);
  },
  text: stateText(T.issue.done),
});

export const deleteDraftTool = defineTool({
  name: T.deleteDraft.name,
  title: T.deleteDraft.title,
  description: T.deleteDraft.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({ id: z.string() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteDraft(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.deleteDraft.done,
});

const edited = state.extend({
  variableSymbol: z.string().nullable(),
  resendSuggested: z.boolean(),
  balanceWarning: z.enum(["none", "overpaid", "underpaid"]),
});
type Edited = z.infer<typeof edited>;

const editedOf = (ctx: ToolContext, invoiceId: string, result: EditResult): Edited => ({
  ...stateOf(ctx, invoiceId),
  variableSymbol: result.variableSymbol,
  resendSuggested: result.resendSuggested,
  balanceWarning: result.balanceWarning,
});

const editedText = (headline: string) => (o: Edited) =>
  [
    headline,
    T.state(o.number ?? R.noNumber, statusLabel(o.status), o.revision),
    ...(o.resendSuggested ? [T.resendSuggested] : []),
    ...(o.balanceWarning === "none" ? [] : [T.balance[o.balanceWarning]]),
    TEXTS.mcp.create.link(o.link),
  ].join("\n");

export const updateIssuedInvoiceTool = defineTool({
  name: T.update.name,
  title: T.update.title,
  description: T.update.description,
  level: "full",
  input: z.strictObject({
    id: id(T.id),
    revision,
    number: z.string().min(1).max(100).describe(T.update.number).optional(),
    variableSymbol: z.string().max(10).describe(T.update.variableSymbol).nullable().optional(),
    dueDate: documentInput.dueDate,
    note: z.string().max(MAX_DOCUMENT_TEXT).describe(TEXTS.mcp.create.note).optional(),
    lines: documentInput.lines.describe(T.update.lines).optional(),
    tags: documentInput.tags,
  }),
  output: edited,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const found = getInvoice(ctx.ownerId, args.id);
    if (!found) throw new McpToolError(TEXTS.invoices.validation.notFound);
    const unit = getPreferences(ctx.ownerId).unit;
    const lines = args.lines
      ? args.lines.map((line) => lineOf(ctx.ownerId, line, found.currency, unit))
      : found.lines.map((line) => ({
          catalogItemId: line.catalogItemId,
          name: line.name,
          description: line.description,
          quantityMilli: line.quantityMilli,
          unit: line.unit,
          unitPriceMinor: line.unitPriceMinor,
          discountKind: line.discountKind,
          discountValue: line.discountValue,
        }));
    // The whole document goes to the service as the web's edit form sends it; what the tool does
    // not take stays as it is.
    const result = updateIssuedWithTags(
      ctx.actor,
      found.id,
      {
        revision: args.revision,
        number: args.number ?? found.number ?? "",
        variableSymbol:
          args.variableSymbol === undefined ? found.variableSymbol : args.variableSymbol,
        bankAccountId: found.bankAccountId,
        issueDate: found.issueDate,
        dueDate: args.dueDate ?? found.dueDate,
        taxableDate: found.taxableDate,
        language: found.language,
        currency: found.currency,
        exchangeRateMicros: found.exchangeRateMicros,
        exchangeRateSource: found.exchangeRateSource,
        foreign: found.foreign,
        clause: found.clause,
        paymentMethod: found.paymentMethod,
        orderRef: found.orderRef,
        reference: found.reference,
        textBefore: found.textBefore,
        textAfter: found.textAfter,
        note: args.note ?? found.note,
        discountKind: found.discountKind,
        discountValue: found.discountValue,
        rounding: found.rounding,
        appearance: found.appearance,
        lines,
      },
      args.tags ?? found.tags.map((tag) => tag.name),
    );
    return editedOf(ctx, found.id, result);
  },
  text: editedText(T.update.done),
});

export const refreshCustomerSnapshotTool = defineTool({
  name: T.refresh.name,
  title: T.refresh.title,
  description: T.refresh.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: edited,
  fieldLabels: T.fields,
  run: (ctx, args) => editedOf(ctx, args.id, refreshCustomerSnapshot(ctx.actor, args.id)),
  text: editedText(T.refresh.done),
});

export const restoreInvoiceVersionTool = defineTool({
  name: T.restoreVersion.name,
  title: T.restoreVersion.title,
  description: T.restoreVersion.description,
  level: "full",
  input: z.strictObject({ versionId: id(T.restoreVersion.versionId) }),
  output: edited,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const version = getVersion(ctx.ownerId, args.versionId);
    // The service refuses a missing or foreign version with its own text.
    const result = restoreVersion(ctx.actor, args.versionId);
    return editedOf(ctx, version!.invoiceId, result);
  },
  text: editedText(T.restoreVersion.done),
});

export const cancelInvoiceTool = onInvoice(T.cancel, "full", {}, (ctx, args) =>
  cancelInvoice(ctx.actor, args.id),
);

export const restoreCancelledInvoiceTool = onInvoice(T.restore, "full", {}, (ctx, args) =>
  restoreInvoice(ctx.actor, args.id),
);

export const createCreditNoteTool = defineTool({
  name: T.creditNote.name,
  title: T.creditNote.title,
  description: T.creditNote.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: draftOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => draftOfId(ctx, createCreditNoteWithSeries(ctx.actor, args.id).id),
  text: draftText(T.creditNote.done),
});

export const deleteImportedInvoiceTool = defineTool({
  name: T.deleteImported.name,
  title: T.deleteImported.title,
  description: T.deleteImported.description,
  level: "full",
  input: z.strictObject({ id: id(T.id) }),
  output: z.object({ id: z.string() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteImported(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => T.deleteImported.done,
});

export const LIFECYCLE_TOOLS = [
  markSentTool,
  markSentManyTool,
  snoozeRemindersTool,
  setRemindersOffTool,
  setPartialRemindersTool,
  issueInvoiceTool,
  deleteDraftTool,
  updateIssuedInvoiceTool,
  refreshCustomerSnapshotTool,
  restoreInvoiceVersionTool,
  cancelInvoiceTool,
  restoreCancelledInvoiceTool,
  createCreditNoteTool,
  deleteImportedInvoiceTool,
];
