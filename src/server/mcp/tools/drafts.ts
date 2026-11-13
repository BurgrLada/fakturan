import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { defineTool } from "../tool";
import { convertAdvanceWithSeries } from "../../services/advances";
import { getCustomer } from "../../services/customers";
import { draftRate } from "../../services/exchange-rates";
import { draftFromTemplate } from "../../services/invoice-templates";
import { duplicateInvoice, getInvoice, saveDraftWithTags } from "../../services/invoices";
import { getPreferences } from "../../services/preferences";
import { documentInput, draftOfId, draftOutput, draftText, keptLine, lineOf } from "./create-draft";

const T = TEXTS.mcp.drafts;
const id = (description: string) => z.string().min(1).max(100).describe(description);

export const updateDraftInvoiceTool = defineTool({
  name: T.update.name,
  title: T.update.title,
  description: T.update.description,
  level: "drafts",
  input: z.strictObject({
    id: id(T.update.id),
    revision: z.number().int().describe(T.update.revision),
    ...documentInput,
    // Without lines the stored ones stay, as in update_issued_invoice.
    lines: documentInput.lines.describe(T.update.lines).optional(),
  }),
  output: draftOutput,
  fieldLabels: T.fields,
  run: async (ctx, args) => {
    const { ownerId, actor } = ctx;
    const found = getInvoice(ownerId, args.id);
    if (!found) throw new McpToolError(TEXTS.invoices.validation.notFound);
    // saveDraft would only say "stale" for an issued document; the assistant needs the reason.
    if (found.status !== "draft") throw new McpToolError(T.notDraft);
    // As in create_draft_invoice: the web picker offers the account's active customers, and the
    // draft's own customer stays allowed.
    const customer = getCustomer(ownerId, args.customerId);
    if (!customer || (customer.archivedAt && customer.id !== found.customerId)) {
      throw new McpToolError(TEXTS.mcp.read.customerNotFound);
    }
    const currency = args.currency ?? found.currency;
    const issueDate = args.issueDate ?? found.issueDate;
    const unit = getPreferences(ownerId).unit;
    const lines = args.lines
      ? args.lines.map((line) => lineOf(ownerId, line, currency, unit))
      : found.lines.map(keptLine);
    // The form fetches a new CNB rate when the currency or the date changes, otherwise keeps it.
    const rateChanged = currency !== found.currency || issueDate !== found.issueDate;
    const rate = rateChanged
      ? await draftRate(actor, { currency, issueDate, taxableDate: found.taxableDate })
      : null;
    // The whole document is replaced as the web form sends it; what the tool does not take stays.
    const saved = saveDraftWithTags(
      actor,
      {
        id: found.id,
        revision: args.revision,
        type: found.type,
        customerId: customer.id,
        seriesId: found.seriesId,
        bankAccountId: found.bankAccountId,
        issueDate,
        dueDate: args.dueDate ?? found.dueDate,
        taxableDate: found.taxableDate,
        language: found.language,
        currency,
        exchangeRateMicros: rateChanged ? (rate?.rateMicros ?? null) : found.exchangeRateMicros,
        exchangeRateSource: rateChanged ? (rate?.source ?? null) : found.exchangeRateSource,
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
    return draftOfId(ctx, saved.id);
  },
  text: draftText(T.update.done),
});

export const duplicateInvoiceTool = defineTool({
  name: T.duplicate.name,
  title: T.duplicate.title,
  description: T.duplicate.description,
  level: "drafts",
  input: z.strictObject({ id: id(T.duplicate.id) }),
  output: draftOutput,
  run: (ctx, args) => draftOfId(ctx, duplicateInvoice(ctx.actor, args.id).id),
  text: draftText(T.duplicate.done),
});

export const draftFromTemplateTool = defineTool({
  name: T.template.name,
  title: T.template.title,
  description: T.template.description,
  level: "drafts",
  input: z.strictObject({ templateId: id(T.template.templateId) }),
  output: draftOutput,
  run: (ctx, args) => draftOfId(ctx, draftFromTemplate(ctx.actor, args.templateId).id),
  text: draftText(T.template.done),
});

export const convertAdvanceToFinalTool = defineTool({
  name: T.convert.name,
  title: T.convert.title,
  description: T.convert.description,
  level: "drafts",
  input: z.strictObject({ id: id(T.convert.id) }),
  output: draftOutput,
  run: (ctx, args) => draftOfId(ctx, convertAdvanceWithSeries(ctx.actor, args.id).id),
  text: draftText(T.convert.done),
});

export const DRAFT_TOOLS = [
  updateDraftInvoiceTool,
  duplicateInvoiceTool,
  draftFromTemplateTool,
  convertAdvanceToFinalTool,
];
