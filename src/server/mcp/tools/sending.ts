import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { McpDenied, McpToolError } from "../errors";
import { appLink } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { ServiceError } from "../../services/access";
import { listEmailLog, resendFromLog, sendInvoice, sendReceipt } from "../../services/invoice-mail";
import { sendManualReminder } from "../../services/reminders";

const T = TEXTS.mcp.sending;

// Refusals the web answers with a confirmation dialog. Only a person may confirm them, so the
// assistant gets a link instead of a flag it could set itself.
const NEEDS_PERSON: readonly string[] = [
  TEXTS.invoiceMail.errors.unknownPending,
  TEXTS.invoiceMail.errors.confirmUnknown,
  TEXTS.reminders.errors.confirmRepeat,
];

function confirmedInWeb<R>(ctx: ToolContext, invoiceId: string, send: () => R): R {
  try {
    return send();
  } catch (error) {
    if (error instanceof ServiceError && NEEDS_PERSON.includes(error.message)) {
      throw new McpDenied(
        TEXTS.mcp.tools.confirmInWeb(appLink(ctx.baseUrl, `/faktury/${invoiceId}`)),
        "confirm_in_web",
      );
    }
    throw error;
  }
}

const id = z.string().min(1).max(100).describe(T.id);
const idempotencyKey = z.uuid().describe(T.idempotencyKey);
const addresses = (description: string) => z.array(z.string()).describe(description);

const message = {
  id,
  to: addresses(T.to),
  cc: addresses(T.cc).default([]),
  bcc: addresses(T.bcc).default([]),
  subject: z.string().describe(T.subject),
  body: z.string().describe(T.body),
  revision: z.number().int().describe(T.revision),
  idempotency_key: idempotencyKey,
};

const queued = z.object({ logId: z.string(), invoiceId: z.string(), link: z.string() });
type Queued = z.infer<typeof queued>;

const queuedOf = (ctx: ToolContext, invoiceId: string, logId: string): Queued => ({
  logId,
  invoiceId,
  link: appLink(ctx.baseUrl, `/faktury/${invoiceId}`),
});

const queuedText = (o: Queued) => [T.queued, TEXTS.mcp.create.link(o.link)].join("\n");

// The service validates the message itself, with the web's own texts.
const sendInputOf = (args: {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  revision: number;
  idempotency_key: string;
}) => ({
  requestId: args.idempotency_key,
  confirmedUnknown: false,
  revision: args.revision,
  to: args.to,
  cc: args.cc,
  bcc: args.bcc,
  subject: args.subject,
  body: args.body,
});

export const sendInvoiceTool = defineTool({
  name: T.invoice.name,
  title: T.invoice.title,
  description: T.invoice.description,
  level: "issue_send",
  input: z.strictObject({
    ...message,
    logId: z.string().min(1).max(100).describe(T.invoice.logId).optional(),
    attachIsdoc: z.boolean().describe(T.invoice.attachIsdoc).optional(),
  }),
  output: queued,
  fieldLabels: T.fields,
  run: (ctx, args) =>
    confirmedInWeb(ctx, args.id, () => {
      const { logId } = sendInvoice(ctx.actor, args.id, {
        ...sendInputOf(args),
        logId: args.logId,
        attachIsdoc: args.attachIsdoc,
      });
      return queuedOf(ctx, args.id, logId);
    }),
  text: queuedText,
});

export const resendFromLogTool = defineTool({
  name: T.resend.name,
  title: T.resend.title,
  description: T.resend.description,
  level: "issue_send",
  input: z.strictObject({
    id,
    logId: z.string().min(1).max(100).describe(T.resend.logId),
    idempotency_key: idempotencyKey,
  }),
  output: queued,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    // The record is reached through its invoice, like a payment, so another invoice has none.
    const owned = listEmailLog(ctx.ownerId, args.id).some((log) => log.id === args.logId);
    if (!owned) throw new McpToolError(TEXTS.invoiceMail.errors.logNotFound);
    return confirmedInWeb(ctx, args.id, () => {
      const { logId } = resendFromLog(ctx.actor, args.logId, {
        confirmedUnknown: false,
        requestId: args.idempotency_key,
      });
      return queuedOf(ctx, args.id, logId);
    });
  },
  text: queuedText,
});

export const sendPaymentReceiptTool = defineTool({
  name: T.receipt.name,
  title: T.receipt.title,
  description: T.receipt.description,
  level: "issue_send",
  input: z.strictObject({
    ...message,
    paymentId: z.string().min(1).max(100).describe(T.receipt.paymentId),
  }),
  output: queued,
  fieldLabels: T.fields,
  run: (ctx, args) =>
    confirmedInWeb(ctx, args.id, () => {
      const { logId } = sendReceipt(ctx.actor, args.id, args.paymentId, sendInputOf(args));
      return queuedOf(ctx, args.id, logId);
    }),
  text: queuedText,
});

export const sendReminderTool = defineTool({
  name: T.reminder.name,
  title: T.reminder.title,
  description: T.reminder.description,
  level: "issue_send",
  input: z.strictObject({
    ...message,
    stageKey: z.string().min(1).max(100).nullable().describe(T.reminder.stageKey),
  }),
  output: queued,
  fieldLabels: T.fields,
  run: (ctx, args) =>
    confirmedInWeb(ctx, args.id, () => {
      const { logId } = sendManualReminder(ctx.actor, args.id, {
        ...sendInputOf(args),
        stageKey: args.stageKey,
        confirmedRepeat: false,
      });
      return queuedOf(ctx, args.id, logId);
    }),
  text: queuedText,
});

export const SENDING_TOOLS = [
  sendInvoiceTool,
  resendFromLogTool,
  sendPaymentReceiptTool,
  sendReminderTool,
];
