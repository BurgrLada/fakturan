import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CURRENCIES } from "@/lib/currency";
import { parseMoney } from "@/lib/money";
import { MAX_SPLIT_PARTS } from "@/lib/notice-queue";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink, money, moneySchema, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import {
  deleteBankAccount,
  hideBankAccount,
  listBankAccounts,
  saveBankAccount,
  setDefaultForCurrency,
  unhideBankAccount,
  type BankAccount,
} from "../../services/bank-accounts";
import {
  assignNotice,
  bankStatus,
  dismissNotice,
  listNotices,
  noticeCandidates,
  noticeCounts,
  restoreNotice,
  splitNotice,
  undoNotice,
} from "../../services/bank-notices";
import { checkMailboxNow } from "../../services/bank-poll";

const T = TEXTS.mcp.bank;
const A = T.accounts;

const id = (description: string) => z.string().min(1).max(100).describe(description);
// Amounts arrive as the text a person types and are read by the form's own parser (MCP-043).
const amount = (description: string) =>
  z
    .string()
    .refine((value) => (parseMoney(value) ?? 0) > 0, TEXTS.mcp.payments.amountInvalid)
    .describe(description);
const minorOf = (value: string | undefined) => (value === undefined ? null : parseMoney(value)!);

// The three views of the Platby page (bank-notices listNotices).
const VIEWS = {
  queue: { statuses: ["pending"] },
  unrecognized: { statuses: ["unrecognized"] },
  history: { statuses: ["matched", "ignored", "dismissed"], limit: 50 },
} as const;

export const listBankNoticesTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({
    view: z.enum(["queue", "unrecognized", "history"]).describe(T.list.view),
  }),
  output: z.object({
    notices: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        reason: z.string().nullable(),
        paidOn: z.string().nullable(),
        amount: moneySchema.nullable(),
        variableSymbol: z.string().nullable(),
        counterpartyName: z.string().nullable(),
        message: z.string().nullable(),
        text: z.string().nullable(),
        receivedAt: z.string(),
        invoices: z.array(z.object({ id: z.string(), number: z.string().nullable() })),
      }),
    ),
    link: z.string(),
  }),
  fieldLabels: T.fields,
  run: (ctx, args) => ({
    notices: listNotices(ctx.ownerId, VIEWS[args.view]).map((row) => ({
      id: row.id,
      status: row.status,
      reason: row.reason,
      paidOn: row.paidOn,
      amount:
        row.amountMinor === null || row.currency === null
          ? null
          : money(row.amountMinor, row.currency),
      variableSymbol: row.variableSymbol,
      counterpartyName: row.counterpartyName,
      message: row.message,
      text: row.text,
      receivedAt: row.receivedAt.toISOString(),
      invoices: row.invoices,
    })),
    link: appLink(ctx.baseUrl, "/platby"),
  }),
  // Everything that came from the bank's e-mail is fenced as data (MCP-033).
  text: (o) =>
    o.notices.length === 0
      ? T.noNotices
      : [
          ...o.notices.flatMap((row) => [
            T.noticeRow(
              row.id,
              T.statuses[row.status] ?? row.status,
              row.paidOn ?? "–",
              row.amount?.formatted ?? "–",
              row.variableSymbol ?? "",
            ),
            ...(row.counterpartyName
              ? [`  ${quoted(T.counterpartyLabel, row.counterpartyName)}`]
              : []),
            ...(row.message ? [`  ${quoted(T.messageLabel, row.message)}`] : []),
            ...(row.text && row.amount === null ? [`  ${quoted(T.textLabel, row.text)}`] : []),
            ...(row.invoices.length > 0
              ? [T.noticeInvoices(row.invoices.map((one) => one.number ?? one.id).join(", "))]
              : []),
          ]),
          o.link,
        ].join("\n"),
});

export const getBankStatusTool = defineTool({
  name: T.status.name,
  title: T.status.title,
  description: T.status.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
    lastCheckAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    failures: z.number().int(),
    pending: z.number().int(),
    unrecognized: z.number().int(),
  }),
  run: (ctx) => {
    const status = bankStatus(ctx.ownerId);
    const counts = noticeCounts(ctx.ownerId);
    return {
      configured: status !== null,
      enabled: status?.enabled ?? false,
      lastCheckAt: status?.lastCheckAt?.toISOString() ?? null,
      lastSuccessAt: status?.lastSuccessAt?.toISOString() ?? null,
      failures: status?.failures ?? 0,
      ...counts,
    };
  },
  text: (o) =>
    [
      o.configured
        ? T.status.summary(o.enabled, o.lastCheckAt ?? "–", o.pending, o.unrecognized)
        : `${T.status.notConfigured} ${T.status.counts(o.pending, o.unrecognized)}`,
      ...(o.failures > 0 ? [T.status.failing(o.failures)] : []),
    ].join("\n"),
});

export const listNoticeCandidatesTool = defineTool({
  name: T.candidates.name,
  title: T.candidates.title,
  description: T.candidates.description,
  level: "read",
  input: z.strictObject({
    id: id(T.noticeId),
    search: z.string().max(100).describe(T.candidates.search).optional(),
  }),
  output: z.object({
    candidates: z.array(
      z.object({
        id: z.string(),
        number: z.string().nullable(),
        customerName: z.string(),
        variableSymbol: z.string().nullable(),
        due: moneySchema,
        suggested: z.boolean(),
      }),
    ),
    more: z.boolean(),
  }),
  fieldLabels: T.fields,
  // The service reads the notice in the user's account and says "Avízo neexistuje" (MCP-074).
  run: (ctx, args) => {
    const result = noticeCandidates(ctx.ownerId, args.id, args.search ?? "");
    return {
      candidates: result.candidates.map((row) => ({
        id: row.id,
        number: row.number,
        customerName: row.customerName,
        variableSymbol: row.variableSymbol,
        due: money(row.dueMinor, row.currency),
        suggested: row.suggested,
      })),
      more: result.more,
    };
  },
  text: (o) =>
    o.candidates.length === 0
      ? T.noCandidates
      : [
          ...o.candidates.map((row) =>
            T.candidates.row(
              row.id,
              row.number ?? "–",
              quoted(TEXTS.mcp.customers.nameLabel, row.customerName),
              row.due.formatted,
              row.suggested,
            ),
          ),
          ...(o.more ? [T.candidates.more] : []),
        ].join("\n"),
});

const done = z.object({ id: z.string() });

function noticeAction(
  texts: { name: string; title: string; description: string; done: string },
  level: "accounting" | "full",
  action: (ctx: ToolContext, noticeId: string) => void,
) {
  return defineTool({
    name: texts.name,
    title: texts.title,
    description: texts.description,
    level,
    input: z.strictObject({ id: id(T.noticeId) }),
    output: done,
    fieldLabels: T.fields,
    run: (ctx, args) => {
      action(ctx, args.id);
      return { id: args.id };
    },
    text: () => texts.done,
  });
}

export const assignNoticeTool = defineTool({
  name: T.assign.name,
  title: T.assign.title,
  description: T.assign.description,
  level: "accounting",
  input: z.strictObject({
    id: id(T.noticeId),
    invoiceId: id(T.invoiceId),
    credited: amount(T.credited).optional(),
  }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    assignNotice(ctx.actor, args.id, {
      invoiceId: args.invoiceId,
      creditedMinor: minorOf(args.credited),
    });
    return { id: args.id };
  },
  text: () => T.assign.done,
});

export const splitNoticeTool = defineTool({
  name: T.split.name,
  title: T.split.title,
  description: T.split.description,
  level: "accounting",
  input: z.strictObject({
    id: id(T.noticeId),
    parts: z
      .array(
        z.strictObject({
          invoiceId: id(T.invoiceId),
          amount: amount(T.split.amount),
          credited: amount(T.credited).optional(),
        }),
      )
      .min(2)
      .max(MAX_SPLIT_PARTS)
      .describe(T.split.parts),
  }),
  output: done,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    splitNotice(ctx.actor, args.id, {
      parts: args.parts.map((part) => ({
        invoiceId: part.invoiceId,
        amountMinor: parseMoney(part.amount)!,
        creditedMinor: minorOf(part.credited),
      })),
    });
    return { id: args.id };
  },
  text: () => T.split.done,
});

export const dismissNoticeTool = noticeAction(T.dismiss, "accounting", (ctx, noticeId) =>
  dismissNotice(ctx.actor, noticeId),
);
export const restoreNoticeTool = noticeAction(T.restoreNotice, "accounting", (ctx, noticeId) =>
  restoreNotice(ctx.actor, noticeId),
);
export const undoNoticeTool = noticeAction(T.undo, "full", (ctx, noticeId) =>
  undoNotice(ctx.actor, noticeId),
);

export const checkMailboxNowTool = defineTool({
  name: T.check.name,
  title: T.check.title,
  description: T.check.description,
  level: "accounting",
  input: z.strictObject({}),
  output: z.object({ queued: z.boolean() }),
  // The saved mailbox credentials are used, never changed; the web also passes a fresh request id.
  run: (ctx) => {
    checkMailboxNow(ctx.actor, randomUUID());
    return { queued: true };
  },
  text: () => T.check.done,
});

// --- bank accounts ---

function ownAccount(ctx: ToolContext, accountId: string): BankAccount {
  const row = listBankAccounts(ctx.ownerId).find((one) => one.id === accountId);
  if (!row) throw new McpToolError(A.notFound);
  return row;
}

export const listBankAccountsTool = defineTool({
  name: A.list.name,
  title: A.list.title,
  description: A.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        currency: z.string(),
        number: z.string(),
        bankCode: z.string(),
        iban: z.string(),
        swift: z.string(),
        isDefault: z.boolean(),
        hidden: z.boolean(),
      }),
    ),
    link: z.string(),
  }),
  run: (ctx) => ({
    accounts: listBankAccounts(ctx.ownerId).map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      number: row.number,
      bankCode: row.bankCode,
      iban: row.iban,
      swift: row.swift,
      isDefault: row.isDefault,
      hidden: row.hidden,
    })),
    link: appLink(ctx.baseUrl, "/nastaveni/ucty"),
  }),
  text: (o) =>
    o.accounts.length === 0
      ? T.noAccounts
      : [
          ...o.accounts.map((row) =>
            A.row(
              row.id,
              quoted(T.accountNameLabel, row.name),
              row.currency,
              row.number && row.bankCode ? `${row.number}/${row.bankCode}` : row.iban,
              (row.isDefault ? A.defaultMark : "") + (row.hidden ? A.hiddenMark : ""),
            ),
          ),
          o.link,
        ].join("\n"),
});

const S = A.save;

export const saveBankAccountTool = defineTool({
  name: S.name,
  title: S.title,
  description: S.description,
  level: "accounting",
  input: z.strictObject({
    id: id(S.id).optional(),
    name: z.string().max(100).describe(S.name_).optional(),
    currency: z.enum(CURRENCIES).describe(S.currency).optional(),
    number: z.string().max(20).describe(S.number).optional(),
    bankCode: z.string().max(4).describe(S.bankCode).optional(),
    iban: z.string().max(42).describe(S.iban).optional(),
    swift: z.string().max(11).describe(S.swift).optional(),
  }),
  output: z.object({ id: z.string(), created: z.boolean() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const existing = args.id ? ownAccount(ctx, args.id) : null;
    // The service checks the whole account, as the web form sends it; what is left out stays.
    const savedId = saveBankAccount(ctx.actor, {
      id: existing?.id,
      name: args.name ?? existing?.name ?? "",
      currency: args.currency ?? existing?.currency ?? "CZK",
      number: args.number ?? existing?.number ?? "",
      bankCode: args.bankCode ?? existing?.bankCode ?? "",
      iban: args.iban ?? existing?.iban ?? "",
      swift: args.swift ?? existing?.swift ?? "",
    });
    return { id: savedId, created: !existing };
  },
  text: (o) => [o.created ? S.created : S.updated, `ID: ${o.id}`].join("\n"),
});

function accountAction(
  texts: { name: string; title: string; description: string; done: string },
  level: "accounting" | "full",
  action: (ctx: ToolContext, account: BankAccount) => void,
) {
  return defineTool({
    name: texts.name,
    title: texts.title,
    description: texts.description,
    level,
    input: z.strictObject({ id: id(A.id) }),
    output: done,
    fieldLabels: T.fields,
    run: (ctx, args) => {
      action(ctx, ownAccount(ctx, args.id));
      return { id: args.id };
    },
    text: () => texts.done,
  });
}

// The web sets the default from the account's own row, so its currency is the account's.
export const setDefaultBankAccountTool = accountAction(A.setDefault, "accounting", (ctx, row) =>
  setDefaultForCurrency(ctx.actor, row.currency, row.id),
);
export const hideBankAccountTool = accountAction(A.hide, "accounting", (ctx, row) =>
  hideBankAccount(ctx.actor, row.id),
);
export const unhideBankAccountTool = accountAction(A.unhide, "accounting", (ctx, row) =>
  unhideBankAccount(ctx.actor, row.id),
);
export const deleteBankAccountTool = accountAction(A.delete, "full", (ctx, row) =>
  deleteBankAccount(ctx.actor, row.id),
);

export const BANK_TOOLS = [
  listBankNoticesTool,
  getBankStatusTool,
  listNoticeCandidatesTool,
  assignNoticeTool,
  splitNoticeTool,
  dismissNoticeTool,
  restoreNoticeTool,
  undoNoticeTool,
  checkMailboxNowTool,
  listBankAccountsTool,
  saveBankAccountTool,
  setDefaultBankAccountTool,
  hideBankAccountTool,
  unhideBankAccountTool,
  deleteBankAccountTool,
];
