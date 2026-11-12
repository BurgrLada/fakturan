import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { customer, emailLog, mcpCallLog } from "@/server/db/schema";
import { sendInvoice } from "@/server/services/invoice-mail";
import { markSent } from "@/server/services/invoice-lifecycle";
import { listVersions } from "@/server/services/invoice-versions";
import { getInvoice } from "@/server/services/invoices";
import { addPayment } from "@/server/services/payments";
import { createTestDb } from "../helpers/db";
import {
  draftFor,
  issuedInvoice,
  ownSmtp,
  seedCustomer,
  seedSupplier,
  webActor,
} from "../helpers/fixtures-mail";
import { callTool, lastAuditSource, mcpAccount } from "../helpers/mcp-tools";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const db = createTestDb();
const NOT_FOUND = /nenalezen|neexistuje/i;

type Level = "read" | "drafts" | "accounting" | "issue_send" | "full";
type Data = Record<string, any>;
const data = (result: CallToolResult): Data => {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Data;
};
const textOf = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

async function account(level: Level = "full", opts: { supplier?: boolean } = {}) {
  const { ownerId, claims } = await mcpAccount(db, { level });
  if (opts.supplier !== false) seedSupplier(ownerId);
  ownSmtp(db, ownerId, 2525);
  const customerId = seedCustomer(ownerId);
  return { ownerId, claims, customerId };
}

const row = (ownerId: string, id: string) => getInvoice(ownerId, id)!;
const mailOf = (ownerId: string) =>
  db.select().from(emailLog).where(eq(emailLog.userId, ownerId)).all();
const lastCall = (ownerId: string, tool: string) =>
  db
    .select()
    .from(mcpCallLog)
    .where(and(eq(mcpCallLog.ownerId, ownerId), eq(mcpCallLog.tool, tool)))
    .orderBy(desc(mcpCallLog.id))
    .get();

const message = (ownerId: string, id: string, over: Record<string, unknown> = {}) => ({
  id,
  to: ["alfa@example.cz"],
  subject: "Faktura",
  body: "Dobrý den, posílám fakturu.",
  revision: row(ownerId, id).revision,
  idempotency_key: randomUUID(),
  ...over,
});

describe("vystavení", () => {
  test("issue_invoice vystaví koncept a vrátí číslo a revizi", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const { id, revision } = draftFor(ownerId, customerId);
    const out = data(await callTool("issue_invoice", claims, { id, revision }));
    expect(out).toMatchObject({ id, status: "issued" });
    expect(out.number).toBe(row(ownerId, id).number);
    expect(out.revision).toBe(row(ownerId, id).revision);
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
  });

  test("[MCP-072] vystavení se starou revizí", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const { id, revision } = draftFor(ownerId, customerId);
    // The web saves the draft in between.
    draftFor(ownerId, customerId, { id, revision, note: "Změna ve webu" });
    const result = await callTool("issue_invoice", claims, { id, revision });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(TEXTS.mcp.tools.stale);
    expect(row(ownerId, id)).toMatchObject({ status: "draft", number: null });
  });

  test("[MCP-073] issue_invoice s problémy vrátí výčet problémů", async () => {
    const { ownerId, claims, customerId } = await account("issue_send", { supplier: false });
    const { id, revision } = draftFor(ownerId, customerId);
    const result = await callTool("issue_invoice", claims, { id, revision });
    expect(result.isError).toBe(true);
    const problems = (result.structuredContent as Data).problems as { message: string }[];
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(textOf(result)).toContain(problem.message);
    expect(row(ownerId, id)).toMatchObject({ status: "draft", number: null });
  });

  test("issue_invoice chce úroveň Vystavování a odesílání", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const { id, revision } = draftFor(ownerId, customerId);
    const result = await callTool("issue_invoice", claims, { id, revision });
    expect(result.isError).toBe(true);
    expect(lastCall(ownerId, "issue_invoice")).toMatchObject({
      outcome: "denied",
      reason: "level",
      requiredLevel: "issue_send",
    });
  });
});

describe("odeslání", () => {
  test("send_invoice dvakrát se stejným idempotency_key založí jeden záznam pošty", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    const args = message(ownerId, id);
    const first = data(await callTool("send_invoice", claims, args));
    const second = data(await callTool("send_invoice", claims, args));
    expect(second.logId).toBe(first.logId);
    expect(mailOf(ownerId)).toHaveLength(1);
    expect(mailOf(ownerId)[0]).toMatchObject({ kind: "invoice", subject: "Faktura" });
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
  });

  test("send_invoice při neznámém doručení vrátí confirm_in_web", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    const { logId } = sendInvoice(webActor(ownerId), id, {
      requestId: randomUUID(),
      to: ["alfa@example.cz"],
      cc: [],
      bcc: [],
      subject: "Faktura",
      body: "Text",
      revision: row(ownerId, id).revision,
    });
    db.update(emailLog).set({ status: "unknown" }).where(eq(emailLog.id, logId)).run();
    const result = await callTool("send_invoice", claims, message(ownerId, id));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      TEXTS.mcp.tools.confirmInWeb(`http://localhost:3000/faktury/${id}`),
    );
    expect(mailOf(ownerId)).toHaveLength(1);
    expect(lastCall(ownerId, "send_invoice")).toMatchObject({
      outcome: "denied",
      reason: "confirm_in_web",
    });
  });

  test("resend_from_log u neznámého doručení vrátí confirm_in_web, u selhaného znovu odešle", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    const first = data(await callTool("send_invoice", claims, message(ownerId, id)));
    db.update(emailLog).set({ status: "unknown" }).where(eq(emailLog.id, first.logId)).run();
    const args = { id, logId: first.logId, idempotency_key: randomUUID() };
    const refused = await callTool("resend_from_log", claims, args);
    expect(refused.isError).toBe(true);
    expect(lastCall(ownerId, "resend_from_log")).toMatchObject({ reason: "confirm_in_web" });

    db.update(emailLog).set({ status: "failed" }).where(eq(emailLog.id, first.logId)).run();
    const again = data(await callTool("resend_from_log", claims, args));
    expect(again.logId).not.toBe(first.logId);
    expect(mailOf(ownerId)).toHaveLength(2);
  });

  test("resend_from_log nenajde záznam pošty jiné faktury", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    const other = issuedInvoice(ownerId, customerId);
    const first = data(await callTool("send_invoice", claims, message(ownerId, id)));
    db.update(emailLog).set({ status: "failed" }).where(eq(emailLog.id, first.logId)).run();
    const result = await callTool("resend_from_log", claims, {
      id: other,
      logId: first.logId,
      idempotency_key: randomUUID(),
    });
    expect(result.isError).toBe(true);
    expect(mailOf(ownerId)).toHaveLength(1);
  });

  test("send_payment_receipt zařadí potvrzení platby", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    const { id: paymentId } = addPayment(webActor(ownerId), id, {
      revision: row(ownerId, id).revision,
      paidOn: "2026-11-02",
      amountMinor: 100_000,
      currency: "CZK",
      method: "transfer",
      note: "",
    });
    const out = data(
      await callTool("send_payment_receipt", claims, { ...message(ownerId, id), paymentId }),
    );
    expect(mailOf(ownerId)).toEqual([
      expect.objectContaining({ id: out.logId, kind: "payment_receipt", paymentId }),
    ]);
  });

  test("send_reminder opakované upomínky vrátí confirm_in_web a nic neodešle", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    markSent(webActor(ownerId), id);
    const first = data(
      await callTool("send_reminder", claims, { ...message(ownerId, id), stageKey: null }),
    );
    // The first one has gone out; while it is still sending, a second click waits instead.
    db.update(emailLog).set({ status: "sent" }).where(eq(emailLog.id, first.logId)).run();
    const result = await callTool("send_reminder", claims, {
      ...message(ownerId, id),
      stageKey: null,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      TEXTS.mcp.tools.confirmInWeb(`http://localhost:3000/faktury/${id}`),
    );
    expect(mailOf(ownerId).filter((mail) => mail.kind === "reminder")).toHaveLength(1);
    expect(lastCall(ownerId, "send_reminder")).toMatchObject({ reason: "confirm_in_web" });
  });

  test("odesílací nástroje nemají v kontraktu žádné potvrzení", async () => {
    const { TOOLS } = await import("@/server/mcp/tool");
    for (const name of [
      "send_invoice",
      "resend_from_log",
      "send_payment_receipt",
      "send_reminder",
    ]) {
      const def = TOOLS.find((tool) => tool.name === name)!;
      const keys = Object.keys((def.input as any).shape);
      expect(keys.some((key) => /confirm/i.test(key))).toBe(false);
    }
  });

  test("send_invoice chce úroveň Vystavování a odesílání", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const id = issuedInvoice(ownerId, customerId);
    const result = await callTool("send_invoice", claims, message(ownerId, id));
    expect(result.isError).toBe(true);
    expect(mailOf(ownerId)).toHaveLength(0);
  });
});

describe("účetní úkony", () => {
  test("mark_sent a mark_sent_many označí faktury jako odeslané", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const one = issuedInvoice(ownerId, customerId);
    const two = issuedInvoice(ownerId, customerId);
    expect(data(await callTool("mark_sent", claims, { id: one }))).toMatchObject({
      id: one,
      status: "sent",
    });
    expect(data(await callTool("mark_sent_many", claims, { ids: [one, two] }))).toEqual({
      done: 1,
      skipped: 1,
    });
    expect(row(ownerId, two).status).toBe("sent");
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
  });

  test("upomínky: odložení, vypnutí a částečné úhrady", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const id = issuedInvoice(ownerId, customerId);
    const today = new Date().toISOString().slice(0, 10);
    data(await callTool("snooze_reminders", claims, { id, until: today }));
    expect(row(ownerId, id).remindersSnoozeUntil).toBe(today);
    data(await callTool("snooze_reminders", claims, { id, until: null }));
    expect(row(ownerId, id).remindersSnoozeUntil).toBeNull();
    data(await callTool("set_reminders_off", claims, { id, off: true }));
    expect(row(ownerId, id).remindersOff).toBe(true);
    data(await callTool("set_partial_reminders", claims, { id, on: true }));
    expect(row(ownerId, id).remindersPartial).toBe(true);
  });

  test("[MCP-074] cizí faktura je jako neexistující", async () => {
    const { claims } = await account("full");
    const other = await account("full");
    const foreign = issuedInvoice(other.ownerId, other.customerId);
    for (const [name, args] of [
      ["mark_sent", { id: foreign }],
      ["cancel_invoice", { id: foreign }],
      ["create_credit_note", { id: foreign }],
      ["delete_draft", { id: foreign }],
    ] as const) {
      const result = await callTool(name, claims, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(NOT_FOUND);
    }
    expect(row(other.ownerId, foreign).status).toBe("issued");
  });
});

describe("plný přístup", () => {
  test("cancel_invoice a restore_cancelled_invoice", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const id = issuedInvoice(ownerId, customerId);
    expect(data(await callTool("cancel_invoice", claims, { id }))).toMatchObject({
      status: "cancelled",
    });
    expect(data(await callTool("restore_cancelled_invoice", claims, { id }))).toMatchObject({
      status: "issued",
    });
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
  });

  test("cancel_invoice chce plný přístup", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    const id = issuedInvoice(ownerId, customerId);
    const result = await callTool("cancel_invoice", claims, { id });
    expect(result.isError).toBe(true);
    expect(lastCall(ownerId, "cancel_invoice")).toMatchObject({ requiredLevel: "full" });
    expect(row(ownerId, id).status).toBe("issued");
  });

  test("create_credit_note vytvoří koncept dobropisu bez čísla", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const id = issuedInvoice(ownerId, customerId);
    const out = data(await callTool("create_credit_note", claims, { id }));
    expect(out.type).toBe("credit_note");
    expect(row(ownerId, out.id)).toMatchObject({
      type: "credit_note",
      status: "draft",
      number: null,
      relatedInvoiceId: id,
    });
  });

  test("delete_draft smaže koncept, vystavenou fakturu ne", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const { id } = draftFor(ownerId, customerId);
    data(await callTool("delete_draft", claims, { id }));
    expect(getInvoice(ownerId, id)).toBeNull();
    const issued = issuedInvoice(ownerId, customerId);
    expect((await callTool("delete_draft", claims, { id: issued })).isError).toBe(true);
    expect(getInvoice(ownerId, issued)).not.toBeNull();
  });

  test("delete_imported_invoice odmítne doklad, který nebyl importovaný", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const id = issuedInvoice(ownerId, customerId);
    const result = await callTool("delete_imported_invoice", claims, { id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(TEXTS.invoices.validation.notImported);
  });

  test("update_issued_invoice upraví poznámku a položky, ostatní zůstane", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const id = issuedInvoice(ownerId, customerId);
    const before = row(ownerId, id);
    const out = data(
      await callTool("update_issued_invoice", claims, {
        id,
        revision: before.revision,
        note: "Opravená poznámka",
        lines: [{ name: "Oprava", quantity: "1", unitPrice: "500" }],
      }),
    );
    const after = row(ownerId, id);
    expect(out).toMatchObject({ id, revision: after.revision });
    expect(after).toMatchObject({
      note: "Opravená poznámka",
      number: before.number,
      dueDate: before.dueDate,
      totalMinor: 50_000,
    });
    expect(after.lines.map((line) => line.name)).toEqual(["Oprava"]);
    expect(lastAuditSource(db, ownerId)).toBe("mcp");

    const stale = await callTool("update_issued_invoice", claims, {
      id,
      revision: before.revision,
      note: "Znovu",
    });
    expect(textOf(stale)).toBe(TEXTS.mcp.tools.stale);
  });

  test("restore_invoice_version vrátí dřívější verzi", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const id = issuedInvoice(ownerId, customerId);
    const original = row(ownerId, id).note;
    data(
      await callTool("update_issued_invoice", claims, {
        id,
        revision: row(ownerId, id).revision,
        note: "Nová poznámka",
      }),
    );
    const version = listVersions(ownerId, id).at(-1)!;
    const out = data(await callTool("restore_invoice_version", claims, { versionId: version.id }));
    expect(out.id).toBe(id);
    expect(row(ownerId, id).note).toBe(original);
  });

  test("refresh_customer_snapshot převezme změněné údaje zákazníka", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const id = issuedInvoice(ownerId, customerId);
    db.update(customer).set({ name: "Alfa nová s.r.o." }).where(eq(customer.id, customerId)).run();
    data(await callTool("refresh_customer_snapshot", claims, { id }));
    expect(row(ownerId, id).customerName).toBe("Alfa nová s.r.o.");
  });
});
