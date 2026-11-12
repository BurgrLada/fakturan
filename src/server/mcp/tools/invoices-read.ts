import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { INVOICE_STATUSES, INVOICE_TYPES } from "@/lib/invoice";
import { EMAIL_STATUSES, EMAIL_TRIGGERS } from "@/lib/mail-send";
import { MESSAGE_KINDS } from "@/lib/email-template";
import { isCalendarDate } from "@/lib/number-format";
import { amountDue } from "@/lib/qr-payload";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quantityText, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import { getCustomer } from "../../services/customers";
import { checkIssuable, previewIssue } from "../../services/invoice-lifecycle";
import {
  listEmailLog,
  mailStateOf,
  sendPrefill,
  type SendPrefill,
} from "../../services/invoice-mail";
import { getVersion, listVersions } from "../../services/invoice-versions";
import {
  getInvoice,
  INVOICE_SORTS,
  INVOICE_STATUS_FILTERS,
  listInvoices,
} from "../../services/invoices";
import { reminderHistory, reminderPrefill } from "../../services/reminders";
import { listTags } from "../../services/tags";

const R = TEXTS.mcp.read;
const T = TEXTS.mcp.invoicesRead;
// Where a service has no limit of its own, a page holds at most 50 rows (MCP-075).
const PAGE_SIZE = 50;

const id = (description: string) => z.string().min(1).max(100).describe(description);
const date = (description: string) =>
  z
    .string(R.dateFormat)
    .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value), R.dateFormat)
    .describe(description);
const isoTime = (value: Date) => value.toISOString();
const statusText = (status: string) =>
  (R.invoice.statuses as Record<string, string>)[status] ?? status;
const numberText = (number: string | null) => (number ? quoted(R.numberLabel, number) : R.noNumber);

// Lists by invoice read nothing for a foreign id; the invoice decides first (MCP-074).
function requireInvoice(ctx: ToolContext, invoiceId: string) {
  const found = getInvoice(ctx.ownerId, invoiceId);
  if (!found) throw new McpToolError(R.invoiceNotFound);
  return found;
}

const invoiceIdInput = z.strictObject({ invoiceId: id(T.invoiceId) });

export const listInvoicesTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({
    q: z.string().trim().min(1).max(100).describe(T.list.q).optional(),
    status: z.enum(INVOICE_STATUS_FILTERS).describe(T.list.status).optional(),
    customerId: id(T.list.customerId).optional(),
    from: date(T.list.from).optional(),
    to: date(T.list.to).optional(),
    currency: z.enum(CURRENCIES).describe(T.list.currency).optional(),
    type: z.enum(INVOICE_TYPES).describe(T.list.type).optional(),
    tagId: id(T.list.tagId).optional(),
    unpaid: z.boolean().describe(T.list.unpaid).optional(),
    sort: z.enum(INVOICE_SORTS).describe(T.list.sort).optional(),
    dir: z.enum(["asc", "desc"]).describe(T.list.dir).optional(),
    page: z.number().int().min(1).max(10_000).describe(T.list.page).optional(),
  }),
  output: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    hasNext: z.boolean(),
    invoices: z.array(
      z.object({
        id: z.string(),
        number: z.string().nullable(),
        type: z.enum(INVOICE_TYPES),
        status: z.enum(INVOICE_STATUSES),
        customerId: z.string().nullable(),
        customerName: z.string(),
        issueDate: z.string().nullable(),
        dueDate: z.string().nullable(),
        overdue: z.boolean(),
        total: moneySchema,
        remaining: moneySchema,
        link: z.string(),
      }),
    ),
  }),
  run: (ctx, filter) => {
    // The list service drops an id that is not the account's, which would list everything.
    if (filter.customerId && !getCustomer(ctx.ownerId, filter.customerId)) {
      throw new McpToolError(R.customerNotFound);
    }
    if (filter.tagId && !listTags(ctx.ownerId).some((tag) => tag.id === filter.tagId)) {
      throw new McpToolError(T.tagNotFound);
    }
    const result = listInvoices(ctx.ownerId, { ...filter, pageSize: PAGE_SIZE });
    return {
      page: result.page,
      pageSize: result.pageSize,
      hasNext: result.hasNext,
      invoices: result.rows.map((row) => ({
        id: row.id,
        number: row.number,
        type: row.type,
        status: row.status,
        customerId: row.customerId,
        customerName: row.customerName,
        issueDate: row.issueDate,
        dueDate: row.dueDate,
        overdue: row.overdue,
        total: money(row.totalMinor, row.currency),
        remaining: money(amountDue(row), row.currency),
        link: appLink(ctx.baseUrl, `/faktury/${row.id}`),
      })),
    };
  },
  text: (o) =>
    o.invoices.length === 0
      ? T.list.empty
      : [
          T.list.heading(o.invoices.length, o.page, o.hasNext),
          ...o.invoices.map((row) =>
            T.list.row(
              numberText(row.number),
              statusText(row.status),
              quoted(R.invoice.customer, row.customerName),
              row.issueDate ?? "–",
              row.total.formatted,
              row.remaining.formatted,
              row.link,
            ),
          ),
        ].join("\n"),
});

export const listInvoiceVersionsTool = defineTool({
  name: T.versions.name,
  title: T.versions.title,
  description: T.versions.description,
  level: "read",
  input: invoiceIdInput,
  output: z.object({
    versions: z.array(
      z.object({
        id: z.string(),
        versionNo: z.number().int(),
        createdAt: z.string(),
        link: z.string(),
      }),
    ),
  }),
  run: (ctx, { invoiceId }) => {
    requireInvoice(ctx, invoiceId);
    return {
      versions: listVersions(ctx.ownerId, invoiceId).map((version) => ({
        id: version.id,
        versionNo: version.versionNo,
        createdAt: isoTime(version.createdAt),
        link: appLink(ctx.baseUrl, `/faktury/${invoiceId}/verze/${version.id}`),
      })),
    };
  },
  text: (o) =>
    o.versions.length === 0
      ? T.versions.empty
      : [
          T.versions.heading(o.versions.length),
          ...o.versions.map((row) => T.versions.row(row.versionNo, row.createdAt, row.id)),
        ].join("\n"),
});

export const getInvoiceVersionTool = defineTool({
  name: T.version.name,
  title: T.version.title,
  description: T.version.description,
  level: "read",
  input: z.strictObject({ invoiceId: id(T.invoiceId), versionId: id(T.version.versionId) }),
  output: z.object({
    id: z.string(),
    invoiceId: z.string(),
    versionNo: z.number().int(),
    createdAt: z.string(),
    number: z.string().nullable(),
    status: z.enum(INVOICE_STATUSES),
    issueDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    taxableDate: z.string().nullable(),
    customerName: z.string(),
    lines: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        quantityMilli: z.number().int(),
        unit: z.string(),
        unitPrice: moneySchema,
        net: moneySchema,
      }),
    ),
    total: moneySchema,
    note: z.string(),
    textBefore: z.string(),
    textAfter: z.string(),
    link: z.string(),
  }),
  run: (ctx, { invoiceId, versionId }) => {
    // As on the web page: the version must belong to the invoice in the address.
    const version = getVersion(ctx.ownerId, versionId);
    if (!version || version.invoiceId !== invoiceId) throw new McpToolError(T.versionNotFound);
    const doc = version.document;
    const m = (minor: number) => money(minor, doc.currency);
    return {
      id: version.id,
      invoiceId,
      versionNo: version.versionNo,
      createdAt: isoTime(version.createdAt),
      number: doc.number,
      status: doc.status,
      issueDate: doc.issueDate,
      dueDate: doc.dueDate,
      taxableDate: doc.taxableDate,
      customerName: doc.snapshot.customer?.name ?? doc.customerName,
      lines: doc.lines.map((line) => ({
        name: line.name,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPrice: m(line.unitPriceMinor),
        net: m(line.netMinor),
      })),
      total: m(doc.totals.totalMinor),
      note: doc.note,
      textBefore: doc.textBefore,
      textAfter: doc.textAfter,
      link: appLink(ctx.baseUrl, `/faktury/${invoiceId}/verze/${version.id}`),
    };
  },
  text: (o) => {
    const optional = (label: string, value: string) => (value ? [quoted(label, value)] : []);
    return [
      T.version.header(o.versionNo, numberText(o.number), o.createdAt),
      quoted(R.invoice.customer, o.customerName),
      R.invoice.dates(o.issueDate ?? "–", o.dueDate ?? "–", o.taxableDate ?? "–"),
      ...o.lines.map((line, index) =>
        R.invoice.line(
          quoted(R.invoice.lineLabel(index + 1), line.name),
          quantityText(line.quantityMilli),
          quoted(R.unitLabel, line.unit),
          line.unitPrice.formatted,
          line.net.formatted,
        ),
      ),
      T.version.total(o.total.formatted),
      ...optional(R.invoice.note, o.note),
      ...optional(R.invoice.textBefore, o.textBefore),
      ...optional(R.invoice.textAfter, o.textAfter),
      o.link,
    ].join("\n");
  },
});

export const listInvoiceMailLogTool = defineTool({
  name: T.mailLog.name,
  title: T.mailLog.title,
  description: T.mailLog.description,
  level: "read",
  input: invoiceIdInput,
  output: z.object({
    sending: z.boolean(),
    problemId: z.string().nullable(),
    entries: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(MESSAGE_KINDS),
        trigger: z.enum(EMAIL_TRIGGERS),
        status: z.enum(EMAIL_STATUSES),
        reason: z.string().nullable(),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        bcc: z.array(z.string()),
        subject: z.string(),
        paymentId: z.string().nullable(),
        createdAt: z.string(),
        sentAt: z.string().nullable(),
        resendable: z.boolean(),
        acknowledgeable: z.boolean(),
      }),
    ),
  }),
  run: (ctx, { invoiceId }) => {
    requireInvoice(ctx, invoiceId);
    const rows = listEmailLog(ctx.ownerId, invoiceId);
    const state = mailStateOf(rows);
    return {
      sending: state.sending,
      problemId: state.problem?.id ?? null,
      entries: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        trigger: row.trigger,
        status: row.status,
        reason: row.reason,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        subject: row.subject,
        paymentId: row.paymentId,
        createdAt: isoTime(row.createdAt),
        sentAt: row.sentAt ? isoTime(row.sentAt) : null,
        resendable: row.resendable,
        acknowledgeable: row.acknowledgeable,
      })),
    };
  },
  text: (o) =>
    o.entries.length === 0
      ? T.mailLog.empty
      : [
          ...(o.sending ? [T.mailLog.sending] : []),
          ...(o.problemId ? [T.mailLog.problem(o.problemId)] : []),
          ...o.entries.map((row) =>
            T.mailLog.row(
              row.createdAt,
              T.emailStatuses[row.status],
              quoted(T.mailLog.recipients, [...row.to, ...row.cc, ...row.bcc].join(", ")),
              quoted(T.mailLog.subject, row.subject),
              row.id,
            ),
          ),
        ].join("\n"),
});

export const listReminderHistoryTool = defineTool({
  name: T.reminders.name,
  title: T.reminders.title,
  description: T.reminders.description,
  level: "read",
  input: invoiceIdInput,
  output: z.object({
    reminders: z.array(
      z.object({
        id: z.string(),
        offsetDays: z.number().int().nullable(),
        trigger: z.enum(EMAIL_TRIGGERS),
        status: z.enum(EMAIL_STATUSES).nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  run: (ctx, { invoiceId }) => {
    requireInvoice(ctx, invoiceId);
    return {
      reminders: reminderHistory(ctx.ownerId, invoiceId).map((row) => ({
        id: row.id,
        offsetDays: row.offsetDays,
        trigger: row.trigger,
        status: row.status,
        createdAt: isoTime(row.createdAt),
      })),
    };
  },
  text: (o) =>
    o.reminders.length === 0
      ? T.reminders.empty
      : o.reminders
          .map((row) =>
            T.reminders.row(
              row.createdAt,
              T.reminders.triggers[row.trigger],
              row.status ? T.emailStatuses[row.status] : "–",
            ),
          )
          .join("\n"),
});

const problemSchema = z.object({ field: z.string(), message: z.string() });

export const checkInvoiceIssuableTool = defineTool({
  name: T.issuable.name,
  title: T.issuable.title,
  description: T.issuable.description,
  level: "read",
  input: z.strictObject({ id: id(R.invoice.id) }),
  output: z.object({ issuable: z.boolean(), problems: z.array(problemSchema) }),
  run: (ctx, input) => {
    const problems = checkIssuable(ctx.ownerId, input.id);
    return { issuable: problems.length === 0, problems };
  },
  text: (o) =>
    o.issuable
      ? T.issuable.ok
      : [T.issuable.problems, ...o.problems.map((problem) => `- ${problem.message}`)].join("\n"),
});

export const previewIssueTool = defineTool({
  name: T.preview.name,
  title: T.preview.title,
  description: T.preview.description,
  level: "read",
  input: z.strictObject({ id: id(R.invoice.id) }),
  output: z.object({
    problems: z.array(problemSchema),
    number: z.string().nullable(),
    variableSymbol: z.string().nullable(),
    issueDate: z.string().nullable(),
    today: z.string(),
    type: z.enum(INVOICE_TYPES),
    customerName: z.string(),
    total: moneySchema,
    discountNotes: z.array(z.string()),
    rateNotes: z.array(z.string()),
  }),
  run: (ctx, input) => {
    const preview = previewIssue(ctx.ownerId, input.id);
    return {
      problems: preview.problems,
      number: preview.number,
      variableSymbol: preview.variableSymbol,
      issueDate: preview.issueDate,
      today: preview.today,
      type: preview.type,
      customerName: preview.customerName,
      total: money(preview.totalMinor, preview.currency),
      discountNotes: preview.discountNotes,
      rateNotes: preview.rateNotes,
    };
  },
  text: (o) =>
    [
      o.number ? T.preview.number(quoted(R.numberLabel, o.number)) : T.preview.noNumber,
      T.preview.summary(
        quoted(R.invoice.customer, o.customerName),
        o.total.formatted,
        o.issueDate ?? "–",
      ),
      ...(o.problems.length > 0
        ? [T.issuable.problems, ...o.problems.map((problem) => `- ${problem.message}`)]
        : []),
      ...(o.discountNotes.length + o.rateNotes.length > 0
        ? [T.preview.notes, ...[...o.discountNotes, ...o.rateNotes].map((note) => `- ${note}`)]
        : []),
    ].join("\n"),
});

const P = T.prepare;

const prefillOutput = z.object({
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  attachmentName: z.string(),
  requestId: z.string(),
  revision: z.number().int(),
  isdocAvailable: z.boolean(),
  attachIsdoc: z.boolean(),
  unknownPending: z.boolean(),
  paused: z.boolean(),
  repeat: z.boolean(),
  logId: z.string().nullable(),
});
type PrefillOutput = z.infer<typeof prefillOutput>;

function prefillResult(prefill: SendPrefill): PrefillOutput {
  return {
    to: prefill.to,
    cc: prefill.cc,
    bcc: prefill.bcc,
    subject: prefill.subject,
    body: prefill.body,
    attachmentName: prefill.attachmentName,
    requestId: prefill.requestId,
    revision: prefill.revision,
    isdocAvailable: prefill.isdocAvailable,
    attachIsdoc: prefill.attachIsdoc,
    unknownPending: prefill.unknownPending,
    paused: prefill.paused,
    repeat: prefill.repeat ?? false,
    logId: prefill.log?.id ?? null,
  };
}

// The message body comes from the user's templates and the document: data, not instructions.
function prefillText(o: PrefillOutput): string {
  return [
    quoted(P.recipients, o.to.join(", ")),
    ...(o.cc.length + o.bcc.length > 0 ? [quoted(P.copies, [...o.cc, ...o.bcc].join(", "))] : []),
    quoted(P.subject, o.subject),
    quoted(P.body, o.body),
    quoted(P.attachment, o.attachmentName),
    P.revision(o.revision),
    ...(o.repeat ? [P.reminder.repeat] : []),
    ...(o.unknownPending ? [P.unknownPending] : []),
    ...(o.paused ? [P.paused] : []),
  ].join("\n");
}

export const prepareInvoiceEmailTool = defineTool({
  name: P.email.name,
  title: P.email.title,
  description: P.email.description,
  level: "read",
  input: z.strictObject({ id: id(R.invoice.id), logId: id(P.email.logId).optional() }),
  output: prefillOutput,
  run: (ctx, input) => prefillResult(sendPrefill(ctx.ownerId, input.id, input.logId)),
  text: prefillText,
});

export const preparePaymentReceiptTool = defineTool({
  name: P.receipt.name,
  title: P.receipt.title,
  description: P.receipt.description,
  level: "read",
  input: z.strictObject({ id: id(R.invoice.id), paymentId: id(P.receipt.paymentId) }),
  output: prefillOutput,
  run: (ctx, input) =>
    prefillResult(
      sendPrefill(ctx.ownerId, input.id, undefined, {
        kind: "payment_receipt",
        paymentId: input.paymentId,
      }),
    ),
  text: prefillText,
});

export const prepareReminderTool = defineTool({
  name: P.reminder.name,
  title: P.reminder.title,
  description: P.reminder.description,
  level: "read",
  input: z.strictObject({
    id: id(R.invoice.id),
    stageKey: id(P.reminder.stageKey).nullable().optional(),
  }),
  output: prefillOutput,
  run: (ctx, input) =>
    prefillResult(reminderPrefill(ctx.ownerId, input.id, input.stageKey ?? null)),
  text: prefillText,
});

export const listTagsTool = defineTool({
  name: T.tags.name,
  title: T.tags.title,
  description: T.tags.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ tags: z.array(z.object({ id: z.string(), name: z.string() })) }),
  run: (ctx) => ({ tags: listTags(ctx.ownerId) }),
  text: (o) =>
    o.tags.length === 0
      ? T.tags.empty
      : o.tags.map((tag) => T.tags.row(tag.id, quoted(T.tags.label, tag.name))).join("\n"),
});

export const INVOICE_READ_TOOLS = [
  listInvoicesTool,
  listInvoiceVersionsTool,
  getInvoiceVersionTool,
  listInvoiceMailLogTool,
  listReminderHistoryTool,
  checkInvoiceIssuableTool,
  previewIssueTool,
  prepareInvoiceEmailTool,
  preparePaymentReceiptTool,
  prepareReminderTool,
  listTagsTool,
];
