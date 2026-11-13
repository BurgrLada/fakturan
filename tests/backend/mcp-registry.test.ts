import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { count, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { nextOccurrences } from "@/lib/recurrence";
import { clock } from "@/server/clock";
import { auditLog, bankNotification, emailLog, importBatch } from "@/server/db/schema";
import { TOOLS } from "@/server/mcp/tool";
import { getInvoice } from "@/server/services/invoices";
import { listVersions } from "@/server/services/invoice-versions";
import { getRecurring } from "@/server/services/recurring";
import { pauseRecurring, processOccurrence } from "@/server/services/recurring-run";
import { createTestDb } from "../helpers/db";
import { seedBankAccount } from "../helpers/fixtures-bank";
import {
  draftFor,
  issuedAdvance,
  issuedInvoice,
  seedCustomer,
  seedSupplier,
  webActor,
} from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";
import { callTool, mcpAccount } from "../helpers/mcp-tools";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const db = createTestDb();
const NOT_FOUND = /nenalezen|neexistuje/i;
type Data = Record<string, any>;
type ToolDef = { name: string; level: string; description: string; input: z.ZodType };
const defs = () => TOOLS as unknown as ToolDef[];

const textOf = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
const data = (result: CallToolResult): Data => {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Data;
};

// Spec ch. 5, one line per tool; Task 11 adds disable_automation to the accounting level.
const EXPECTED: Record<string, string[]> = {
  read: [
    "get_overview",
    "list_unpaid_invoices",
    "search_customers",
    "search_catalog",
    "get_invoice",
    "list_invoices",
    "list_invoice_versions",
    "get_invoice_version",
    "list_invoice_mail_log",
    "list_reminder_history",
    "check_invoice_issuable",
    "preview_issue",
    "prepare_invoice_email",
    "prepare_payment_receipt",
    "prepare_reminder",
    "list_tags",
    "list_customers",
    "get_customer",
    "lookup_company_ares",
    "list_catalog",
    "get_catalog_item",
    "list_catalog_categories",
    "list_units",
    "list_bank_notices",
    "get_bank_status",
    "list_notice_candidates",
    "list_bank_accounts",
    "list_recurring",
    "get_recurring",
    "list_recurring_runs",
    "list_plan_invoices",
    "preview_recurring",
    "list_invoice_templates",
    "get_invoice_template",
    "list_number_series",
    "get_supplier",
    "get_preferences",
    "get_automation",
    "list_reminder_rules",
    "list_email_templates",
    "get_email_template",
    "get_report",
    "get_tax_overview",
    "quick_search",
    "list_audit",
    "get_entity_history",
    "list_import_batches",
    "get_exchange_rate",
  ],
  drafts: [
    "create_draft_invoice",
    "update_draft_invoice",
    "duplicate_invoice",
    "draft_from_template",
    "convert_advance_to_final",
    "save_customer",
    "archive_customer",
    "restore_customer",
    "verify_customer_vat",
    "save_catalog_item",
    "archive_catalog_item",
    "restore_catalog_item",
    "save_unit",
    "save_line_to_catalog",
  ],
  accounting: [
    "mark_sent",
    "mark_sent_many",
    "snooze_reminders",
    "set_reminders_off",
    "set_partial_reminders",
    "add_payment",
    "add_refund",
    "update_payment",
    "mark_paid",
    "mark_paid_many",
    "assign_notice",
    "split_notice",
    "dismiss_notice",
    "restore_notice",
    "check_mailbox_now",
    "save_bank_account",
    "set_default_bank_account",
    "hide_bank_account",
    "unhide_bank_account",
    "save_recurring",
    "pause_recurring",
    "resolve_missed_run",
    "recurring_from_template",
    "save_invoice_as_template",
    "save_number_series",
    "set_default_series",
    "save_supplier",
    "save_preferences",
    "disable_automation",
    "pause_automation",
    "set_send_time",
    "set_daily_digest",
    "set_period_summary",
    "set_tax_reminder",
    "set_limit_mail",
    "save_reminder_rule",
    "save_email_template",
    "reset_email_template",
  ],
  issue_send: [
    "issue_invoice",
    "send_invoice",
    "resend_from_log",
    "send_payment_receipt",
    "send_reminder",
    "resume_recurring",
    "set_next_number",
  ],
  full: [
    "delete_draft",
    "update_issued_invoice",
    "refresh_customer_snapshot",
    "restore_invoice_version",
    "cancel_invoice",
    "restore_cancelled_invoice",
    "create_credit_note",
    "delete_imported_invoice",
    "delete_customer",
    "delete_unit",
    "delete_payment",
    "delete_bank_account",
    "delete_recurring",
    "delete_invoice_template",
    "delete_number_series",
    "delete_reminder_rule",
    "undo_notice",
    "undo_import",
  ],
};

const CONFIRM_FLAGS = ["confirmed", "confirmedRepeat", "confirmedUnknown", "confirmSend"];

function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const item of schema) propertyNames(item, into);
  else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value && typeof value === "object") {
        for (const name of Object.keys(value)) into.add(name);
      }
      propertyNames(value, into);
    }
  }
  return into;
}

const TOOLS_DIR = join(process.cwd(), "src/server/mcp/tools");
const sources = () =>
  readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(TOOLS_DIR, name), "utf8") }));

describe("registr nástrojů", () => {
  test("[MCP-070] sada nástrojů odpovídá návrhu", () => {
    const expected = Object.entries(EXPECTED)
      .flatMap(([level, names]) => names.map((name) => ({ name, level })))
      .sort((a, b) => a.name.localeCompare(b.name));
    const actual = defs()
      .map(({ name, level }) => ({ name, level }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(actual).toEqual(expected);
  });

  test("[MCP-071] anglické snake_case názvy, české popisy, částky jako desetinné řetězce", () => {
    for (const def of defs()) {
      expect(def.name, def.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(def.description, def.name).toMatch(/[áčďéěíňóřšťúůýž]/i);
      const names = [...propertyNames(z.toJSONSchema(def.input))];
      expect(
        names.filter((name) => name.endsWith("Minor")),
        def.name,
      ).toEqual([]);
    }
  });

  test("[MCP-070] žádné vstupní schéma neobsahuje potvrzovací příznak", () => {
    for (const def of defs()) {
      const names = propertyNames(z.toJSONSchema(def.input));
      for (const flag of CONFIRM_FLAGS) expect(names.has(flag), `${def.name}.${flag}`).toBe(false);
    }
  });

  test("[MCP-070] žádný nástroj nevolá služby ze 5.7", () => {
    for (const { name, text } of sources()) {
      for (const service of ["closeDifference", "acknowledgeUnknown", "bulkSend"]) {
        expect(text.includes(service), `${name}: ${service}`).toBe(false);
      }
      expect(/setPaused\([^,]*,\s*false/.test(text), `${name}: setPaused(false)`).toBe(false);
      expect(/setAutomation\([^,]*,[^,]*,\s*true/.test(text), `${name}: setAutomation(true)`).toBe(
        false,
      );
    }
  });

  test("[MCP-070] nástroje neobsahují SQL", () => {
    for (const { name, text } of sources()) {
      expect(/from "drizzle-orm/.test(text), `${name}: drizzle-orm`).toBe(false);
      expect(/from "(\.\.\/\.\.\/db|@\/server\/db)/.test(text), `${name}: db`).toBe(false);
    }
  });
});

// Account A owns one record of every kind an id-taking tool can point at.
async function ownerA() {
  const { ownerId, claims } = await mcpAccount(db, { level: "full" });
  seedSupplier(ownerId);
  const now = clock.now();
  const today = now.toISOString().slice(0, 10);
  const customerId = seedCustomer(ownerId);
  const invoiceId = issuedInvoice(ownerId, customerId);
  const draftId = draftFor(ownerId, customerId).id;
  const advanceId = issuedAdvance(ownerId, customerId);
  const revision = () => getInvoice(ownerId, invoiceId)!.revision;

  const { paymentId } = data(
    await callTool("add_payment", claims, {
      invoiceId,
      revision: revision(),
      paidOn: today,
      amount: "100",
      method: "transfer",
    }),
  );
  data(
    await callTool("update_issued_invoice", claims, {
      id: invoiceId,
      revision: revision(),
      note: "Oprava",
    }),
  );
  const versionId = listVersions(ownerId, invoiceId).at(-1)!.id;

  const logId = randomUUID();
  db.insert(emailLog)
    .values({
      id: logId,
      userId: ownerId,
      invoiceId,
      kind: "invoice",
      trigger: "manual",
      to: ["alfa@example.cz"],
      cc: [],
      bcc: [],
      subject: "Faktura",
      body: "Dobrý den",
      status: "sent",
      invoiceRevision: 1,
      messageId: `<${logId}@example.cz>`,
      createdAt: now,
      updatedAt: now,
      sentAt: now,
    })
    .run();

  const noticeId = randomUUID();
  db.insert(bankNotification)
    .values({
      id: noticeId,
      userId: ownerId,
      dedupeKey: randomUUID(),
      bank: "fio",
      status: "pending",
      authResult: "pass",
      amountMinor: 10_000,
      currency: "CZK",
      paidOn: today,
      variableSymbol: "999999",
      counterpartyName: "Alfa",
      message: "",
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const batchId = randomUUID();
  db.insert(importBatch)
    .values({
      id: batchId,
      userId: ownerId,
      kind: "isdoc",
      status: "done",
      summary: { invoices: 0, customers: 0 },
      createdAt: now,
      updatedAt: now,
      committedAt: now,
    })
    .run();

  const planId = savePlan(ownerId, customerId);
  const missedPlan = savePlan(ownerId, null);
  const plan = getRecurring(ownerId, missedPlan)!;
  const occurrence = nextOccurrences(plan, plan.cursorDate, 1)[0]!;
  pauseRecurring(webActor(ownerId), missedPlan);
  const { runId } = processOccurrence(ownerId, missedPlan, occurrence)!;
  const runs = data(await callTool("list_recurring_runs", claims, { id: missedPlan })).runs;
  expect(runs.map((run: Data) => run.status)).toEqual(["missed"]);

  const catalogId = data(
    await callTool("save_catalog_item", claims, { name: "Audit", unit: "ks", price: "100" }),
  ).id;
  const unitId = data(await callTool("save_unit", claims, { name: "km" })).id;
  const templateId = data(
    await callTool("save_invoice_as_template", claims, { id: invoiceId, name: "Měsíční" }),
  ).id;
  const seriesId = data(
    await callTool("save_number_series", claims, {
      name: "Projekty",
      documentType: "invoice",
      template: "P{RRRR}-{NNN}",
      reset: "yearly",
    }),
  ).id;
  const ruleId = data(await callTool("save_reminder_rule", claims, { offsetDays: 7 })).id;
  const bankAccountId = seedBankAccount(db, ownerId, now);

  return {
    ownerId,
    customerId,
    invoiceId,
    draftId,
    advanceId,
    paymentId: paymentId as string,
    versionId,
    logId,
    noticeId,
    batchId,
    planId,
    runId,
    catalogId: catalogId as string,
    unitId: unitId as string,
    templateId: templateId as string,
    seriesId: seriesId as string,
    ruleId: ruleId as string,
    bankAccountId,
  };
}

type Ids = Awaited<ReturnType<typeof ownerA>>;
const mail = { to: ["b@example.cz"], cc: [], bcc: [], subject: "S", body: "B", revision: 1 };
const line = [{ name: "X", quantity: "1", unitPrice: "100" }];

// Every tool whose input names a record, called from account B with account A's id.
const FOREIGN: Record<string, (a: Ids) => Data> = {
  get_invoice: (a) => ({ id: a.invoiceId }),
  create_draft_invoice: (a) => ({ customerId: a.customerId, lines: line }),
  list_invoice_versions: (a) => ({ invoiceId: a.invoiceId }),
  get_invoice_version: (a) => ({ invoiceId: a.invoiceId, versionId: a.versionId }),
  list_invoice_mail_log: (a) => ({ invoiceId: a.invoiceId }),
  list_reminder_history: (a) => ({ invoiceId: a.invoiceId }),
  check_invoice_issuable: (a) => ({ id: a.draftId }),
  preview_issue: (a) => ({ id: a.draftId }),
  prepare_invoice_email: (a) => ({ id: a.invoiceId }),
  prepare_payment_receipt: (a) => ({ id: a.invoiceId, paymentId: a.paymentId }),
  prepare_reminder: (a) => ({ id: a.invoiceId }),
  update_draft_invoice: (a) => ({
    id: a.draftId,
    revision: 1,
    customerId: a.customerId,
    lines: line,
  }),
  duplicate_invoice: (a) => ({ id: a.invoiceId }),
  draft_from_template: (a) => ({ templateId: a.templateId }),
  convert_advance_to_final: (a) => ({ id: a.advanceId }),
  get_customer: (a) => ({ id: a.customerId }),
  save_customer: (a) => ({ id: a.customerId, phone: "123" }),
  archive_customer: (a) => ({ id: a.customerId }),
  restore_customer: (a) => ({ id: a.customerId }),
  verify_customer_vat: (a) => ({ id: a.customerId }),
  delete_customer: (a) => ({ id: a.customerId }),
  get_catalog_item: (a) => ({ id: a.catalogId }),
  save_catalog_item: (a) => ({ id: a.catalogId, name: "Cizí" }),
  archive_catalog_item: (a) => ({ id: a.catalogId }),
  restore_catalog_item: (a) => ({ id: a.catalogId }),
  delete_unit: (a) => ({ id: a.unitId }),
  add_payment: (a) => ({
    invoiceId: a.invoiceId,
    revision: 1,
    paidOn: "2026-01-01",
    amount: "1",
    method: "cash",
  }),
  add_refund: (a) => ({
    invoiceId: a.invoiceId,
    revision: 1,
    paidOn: "2026-01-01",
    amount: "1",
    method: "cash",
  }),
  update_payment: (a) => ({ invoiceId: a.invoiceId, paymentId: a.paymentId, revision: 1 }),
  mark_paid: (a) => ({ id: a.invoiceId, revision: 1 }),
  delete_payment: (a) => ({ invoiceId: a.invoiceId, paymentId: a.paymentId, revision: 1 }),
  list_notice_candidates: (a) => ({ id: a.noticeId }),
  assign_notice: (a) => ({ id: a.noticeId, invoiceId: a.invoiceId }),
  split_notice: (a) => ({
    id: a.noticeId,
    parts: [
      { invoiceId: a.invoiceId, amount: "50" },
      { invoiceId: a.advanceId, amount: "50" },
    ],
  }),
  dismiss_notice: (a) => ({ id: a.noticeId }),
  restore_notice: (a) => ({ id: a.noticeId }),
  undo_notice: (a) => ({ id: a.noticeId }),
  save_bank_account: (a) => ({ id: a.bankAccountId, name: "Cizí" }),
  set_default_bank_account: (a) => ({ id: a.bankAccountId }),
  hide_bank_account: (a) => ({ id: a.bankAccountId }),
  unhide_bank_account: (a) => ({ id: a.bankAccountId }),
  delete_bank_account: (a) => ({ id: a.bankAccountId }),
  mark_sent: (a) => ({ id: a.invoiceId }),
  snooze_reminders: (a) => ({ id: a.invoiceId, until: null }),
  set_reminders_off: (a) => ({ id: a.invoiceId, off: true }),
  set_partial_reminders: (a) => ({ id: a.invoiceId, on: true }),
  issue_invoice: (a) => ({ id: a.draftId, revision: 1 }),
  delete_draft: (a) => ({ id: a.draftId }),
  update_issued_invoice: (a) => ({ id: a.invoiceId, revision: 1, note: "Cizí" }),
  refresh_customer_snapshot: (a) => ({ id: a.invoiceId }),
  restore_invoice_version: (a) => ({ versionId: a.versionId }),
  cancel_invoice: (a) => ({ id: a.invoiceId }),
  restore_cancelled_invoice: (a) => ({ id: a.invoiceId }),
  create_credit_note: (a) => ({ id: a.invoiceId }),
  delete_imported_invoice: (a) => ({ id: a.invoiceId }),
  send_invoice: (a) => ({ id: a.invoiceId, ...mail, idempotency_key: randomUUID() }),
  resend_from_log: (a) => ({ id: a.invoiceId, logId: a.logId, idempotency_key: randomUUID() }),
  send_payment_receipt: (a) => ({
    id: a.invoiceId,
    paymentId: a.paymentId,
    ...mail,
    idempotency_key: randomUUID(),
  }),
  send_reminder: (a) => ({
    id: a.invoiceId,
    ...mail,
    stageKey: null,
    idempotency_key: randomUUID(),
  }),
  get_recurring: (a) => ({ id: a.planId }),
  list_recurring_runs: (a) => ({ id: a.planId }),
  list_plan_invoices: (a) => ({ id: a.planId }),
  preview_recurring: (a) => ({ id: a.planId }),
  save_recurring: (a) => ({ id: a.planId, name: "Cizí" }),
  pause_recurring: (a) => ({ id: a.planId }),
  resume_recurring: (a) => ({ id: a.planId }),
  recurring_from_template: (a) => ({ id: a.templateId }),
  delete_recurring: (a) => ({ id: a.planId }),
  get_invoice_template: (a) => ({ id: a.templateId }),
  save_invoice_as_template: (a) => ({ id: a.invoiceId, name: "Cizí" }),
  delete_invoice_template: (a) => ({ id: a.templateId }),
  save_number_series: (a) => ({
    id: a.seriesId,
    name: "Cizí",
    documentType: "invoice",
    template: "C{RRRR}-{NNN}",
    reset: "yearly",
  }),
  set_default_series: (a) => ({ id: a.seriesId }),
  set_next_number: (a) => ({ id: a.seriesId, next: 5 }),
  delete_number_series: (a) => ({ id: a.seriesId }),
  save_reminder_rule: (a) => ({ id: a.ruleId, offsetDays: 3 }),
  delete_reminder_rule: (a) => ({ id: a.ruleId }),
  undo_import: (a) => ({ id: a.batchId }),
};

// Tools that answer a foreign id without an error: an optional filter, a history lookup, or a bulk
// action that skips ids it cannot use, or a service whose one message covers both a missing and a
// settled run. The answer must be the same as for ids that never existed.
const SAME_AS_MISSING: Record<string, (a: Ids) => Data> = {
  list_unpaid_invoices: (a) => ({ customerId: a.customerId }),
  list_invoices: (a) => ({ customerId: a.customerId }),
  get_entity_history: (a) => ({ entity: "invoice", entityId: a.invoiceId }),
  mark_paid_many: (a) => ({ ids: [a.invoiceId] }),
  mark_sent_many: (a) => ({ ids: [a.invoiceId] }),
  resolve_missed_run: (a) => ({ runId: a.runId, action: "skip" }),
};

const idTaking = () =>
  defs()
    .filter((def) =>
      Object.keys((z.toJSONSchema(def.input) as Data).properties ?? {}).some((key) =>
        /^(id|ids)$|Id$/.test(key),
      ),
    )
    .map((def) => def.name)
    .sort();

// The tool's answer with every id of the given set replaced, so two answers compare by shape.
const normalized = (result: CallToolResult, ids: Ids) => {
  let out = JSON.stringify({ isError: result.isError ?? false, data: result.structuredContent });
  out += textOf(result);
  for (const id of Object.values(ids)) out = out.replaceAll(id, "ID");
  return out;
};

describe("izolace účtů", () => {
  test("[MCP-074] každý nástroj s ID je ošetřen", () => {
    expect(idTaking()).toEqual([...Object.keys(FOREIGN), ...Object.keys(SAME_AS_MISSING)].sort());
  });

  test("[MCP-074] cizí ID se chová jako neexistující u každého nástroje", async () => {
    const a = await ownerA();
    const { claims } = await mcpAccount(db, { level: "full" });
    const missing = Object.fromEntries(
      Object.keys(a).map((key) => [key, randomUUID()]),
    ) as unknown as Ids;
    const auditOfA = () =>
      db.select({ n: count() }).from(auditLog).where(eq(auditLog.ownerId, a.ownerId)).get()!.n;
    const before = auditOfA();

    for (const [name, args] of Object.entries(FOREIGN)) {
      const result = await callTool(name, claims, args(a));
      expect(result.isError, `${name}: ${textOf(result)}`).toBe(true);
      expect(textOf(result), name).toMatch(NOT_FOUND);
    }
    for (const [name, args] of Object.entries(SAME_AS_MISSING)) {
      const foreign = normalized(await callTool(name, claims, args(a)), a);
      const none = normalized(await callTool(name, claims, args(missing)), missing);
      expect(foreign, name).toBe(none);
    }
    expect(auditOfA()).toBe(before);
  });
});
