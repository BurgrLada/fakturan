import type { CallToolResult } from "@modelcontextprotocol/server";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { nextOccurrences } from "@/lib/recurrence";
import { TEXTS } from "@/lib/texts";
import { mcpCallLog, recurringInvoice, recurringRun } from "@/server/db/schema";
import { setAutomation } from "@/server/services/automation";
import { getTemplate, listTemplates } from "@/server/services/invoice-templates";
import { listSeries } from "@/server/services/number-series";
import { getRecurring } from "@/server/services/recurring";
import { pauseRecurring, processOccurrence } from "@/server/services/recurring-run";
import { TOOLS } from "@/server/mcp/tool";
import { createTestDb } from "../helpers/db";
import { issuedInvoice, seedCustomer, seedSupplier, webActor } from "../helpers/fixtures-mail";
import { savePlan } from "../helpers/fixtures-recurring";
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

async function account(level: Level = "full") {
  const { ownerId, claims } = await mcpAccount(db, { level });
  seedSupplier(ownerId);
  const customerId = seedCustomer(ownerId);
  return { ownerId, claims, customerId };
}

const lastCall = (ownerId: string, tool: string) =>
  db
    .select()
    .from(mcpCallLog)
    .where(and(eq(mcpCallLog.ownerId, ownerId), eq(mcpCallLog.tool, tool)))
    .orderBy(desc(mcpCallLog.id))
    .get();

const plansOf = (ownerId: string) =>
  db.select().from(recurringInvoice).where(eq(recurringInvoice.userId, ownerId)).all();

const newPlan = (customerId: string, over: Record<string, unknown> = {}) => ({
  name: "Správa webu",
  customerId,
  lines: [{ name: "Správa za {{mesic}}/{{rok}}", quantity: "1", unitPrice: "1000" }],
  ...over,
});

describe("pravidelné faktury", () => {
  test("save_recurring založí plán v režimu koncept a get_recurring ho vrátí", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const saved = data(await callTool("save_recurring", claims, newPlan(customerId)));
    const plan = getRecurring(ownerId, saved.id)!;
    expect(plan.mode).toBe("draft");
    expect(plan.document.lines.map((line) => line.name)).toEqual(["Správa za {{mesic}}/{{rok}}"]);
    expect(plan.document.lines[0]!.unitPriceMinor).toBe(100_000);
    expect(lastAuditSource(db, ownerId)).toBe("mcp");

    const got = data(await callTool("get_recurring", claims, { id: saved.id }));
    expect(got).toMatchObject({ id: saved.id, name: "Správa webu", mode: "draft" });
    expect(got.lines.map((line: Data) => line.name)).toEqual(["Správa za {{mesic}}/{{rok}}"]);
    const list = data(await callTool("list_recurring", claims, {}));
    expect(list.plans.map((p: Data) => p.id)).toEqual([saved.id]);
  });

  test("save_recurring s id upraví jen uvedená pole", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const id = savePlan(ownerId, customerId);
    const before = getRecurring(ownerId, id)!;
    data(await callTool("save_recurring", claims, { id, name: "Nový název" }));
    const after = getRecurring(ownerId, id)!;
    expect(after.name).toBe("Nový název");
    expect(after.document).toEqual(before.document);
    expect(after.frequency).toBe(before.frequency);
  });

  test("[MCP-051] úprava plánu v režimu issue vyžaduje issue_send", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const id = savePlan(ownerId, customerId, { mode: "issue" });
    const result = await callTool("save_recurring", claims, {
      id,
      mode: "draft",
      name: "Jinak",
    });
    expect(result.isError).toBe(true);
    expect(lastCall(ownerId, "save_recurring")).toMatchObject({
      outcome: "denied",
      reason: "level",
      requiredLevel: "issue_send",
    });
    expect(getRecurring(ownerId, id)).toMatchObject({ mode: "issue", name: "Správa webu" });
  });

  test("[MCP-051] nový plán v režimu issue vyžaduje issue_send", async () => {
    const low = await account("accounting");
    const refused = await callTool(
      "save_recurring",
      low.claims,
      newPlan(low.customerId, { mode: "issue" }),
    );
    expect(refused.isError).toBe(true);
    expect(lastCall(low.ownerId, "save_recurring")).toMatchObject({
      requiredLevel: "issue_send",
    });
    expect(plansOf(low.ownerId)).toHaveLength(0);

    const high = await account("issue_send");
    const saved = data(
      await callTool("save_recurring", high.claims, newPlan(high.customerId, { mode: "issue" })),
    );
    expect(getRecurring(high.ownerId, saved.id)?.mode).toBe("issue");
  });

  test("save_recurring v režimu send bez potvrzení odmítne větou služby", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    setAutomation(webActor(ownerId), "recurringSend", true, { confirmed: true });
    const result = await callTool("save_recurring", claims, newPlan(customerId, { mode: "send" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(TEXTS.recurring.validation.sendNotConfirmed);
    expect(plansOf(ownerId)).toHaveLength(0);
    const def = TOOLS.find((tool) => tool.name === "save_recurring")!;
    const keys = Object.keys((def.input as any).shape);
    expect(keys.filter((key) => /confirm/i.test(key))).toEqual([]);
  });

  test("preview_recurring vrátí nejbližší vystavení a nic neuloží", async () => {
    const { ownerId, claims, customerId } = await account("read");
    const result = data(
      await callTool("preview_recurring", claims, {
        ...newPlan(customerId),
        startsOn: "2026-12-01",
        issueRule: "day",
        issueDay: 5,
      }),
    );
    expect(result.occurrences.length).toBeGreaterThan(0);
    expect(result.occurrences[0].issueDate).toBe("2026-12-05");
    expect(plansOf(ownerId)).toHaveLength(0);
  });

  test("pause_recurring a resume_recurring, obnovení vyžaduje issue_send", async () => {
    const low = await account("accounting");
    const id = savePlan(low.ownerId, low.customerId);
    expect(data(await callTool("pause_recurring", low.claims, { id })).status).toBe("paused");
    const refused = await callTool("resume_recurring", low.claims, { id });
    expect(refused.isError).toBe(true);
    expect(lastCall(low.ownerId, "resume_recurring")).toMatchObject({
      requiredLevel: "issue_send",
    });

    const high = await account("issue_send");
    const other = savePlan(high.ownerId, high.customerId);
    pauseRecurring(webActor(high.ownerId), other);
    expect(data(await callTool("resume_recurring", high.claims, { id: other })).status).toBe(
      "active",
    );
  });

  test("resolve_missed_run vynechá zmeškaný běh", async () => {
    const { ownerId, claims } = await account("accounting");
    const id = savePlan(ownerId, null);
    const plan = getRecurring(ownerId, id)!;
    const occurrence = nextOccurrences(plan, plan.cursorDate, 1)[0]!;
    pauseRecurring(webActor(ownerId), id);
    const { runId } = processOccurrence(ownerId, id, occurrence)!;
    const runs = data(await callTool("list_recurring_runs", claims, { id }));
    expect(runs.runs.map((run: Data) => run.status)).toEqual(["missed"]);

    data(await callTool("resolve_missed_run", claims, { runId, action: "skip" }));
    const run = db.select().from(recurringRun).where(eq(recurringRun.id, runId)).get();
    expect(run?.status).not.toBe("missed");
  });

  test("[MCP-074] plán jiného účtu se chová jako neexistující", async () => {
    const mine = await account("full");
    const theirs = await account("full");
    const foreign = savePlan(theirs.ownerId, theirs.customerId);
    for (const name of [
      "get_recurring",
      "list_recurring_runs",
      "list_plan_invoices",
      "pause_recurring",
      "delete_recurring",
    ]) {
      const result = await callTool(name, mine.claims, { id: foreign });
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(NOT_FOUND);
    }
    expect(getRecurring(theirs.ownerId, foreign)).not.toBeNull();
  });

  test("delete_recurring smaže plán až na úrovni full", async () => {
    const low = await account("issue_send");
    const id = savePlan(low.ownerId, low.customerId);
    expect((await callTool("delete_recurring", low.claims, { id })).isError).toBe(true);
    expect(lastCall(low.ownerId, "delete_recurring")).toMatchObject({ requiredLevel: "full" });

    const high = await account("full");
    const other = savePlan(high.ownerId, high.customerId);
    data(await callTool("delete_recurring", high.claims, { id: other }));
    expect(getRecurring(high.ownerId, other)).toBeNull();
  });
});

describe("šablony faktur", () => {
  test("save_invoice_as_template, výpis, detail a plán ze šablony", async () => {
    const { ownerId, claims, customerId } = await account("accounting");
    const invoiceId = issuedInvoice(ownerId, customerId);
    const saved = data(
      await callTool("save_invoice_as_template", claims, { id: invoiceId, name: "Měsíční" }),
    );
    expect(getTemplate(ownerId, saved.id)?.name).toBe("Měsíční");

    const list = data(await callTool("list_invoice_templates", claims, {}));
    expect(list.templates.map((t: Data) => t.id)).toEqual([saved.id]);
    const got = data(await callTool("get_invoice_template", claims, { id: saved.id }));
    expect(got).toMatchObject({ id: saved.id, name: "Měsíční" });
    expect(got.lines.length).toBeGreaterThan(0);

    const plan = data(await callTool("recurring_from_template", claims, { id: saved.id }));
    expect(getRecurring(ownerId, plan.id)?.name).toBe("Měsíční");
  });

  test("delete_invoice_template až na úrovni full", async () => {
    const { ownerId, claims, customerId } = await account("full");
    const invoiceId = issuedInvoice(ownerId, customerId);
    const saved = data(
      await callTool("save_invoice_as_template", claims, { id: invoiceId, name: "Měsíční" }),
    );
    data(await callTool("delete_invoice_template", claims, { id: saved.id }));
    expect(listTemplates(ownerId)).toEqual([]);
  });
});

describe("číselné řady", () => {
  test("list_number_series ukáže řady s příštím číslem", async () => {
    const { ownerId, claims, customerId } = await account("read");
    issuedInvoice(ownerId, customerId);
    const result = data(await callTool("list_number_series", claims, {}));
    const invoices = result.series.find((s: Data) => s.documentType === "invoice" && s.isDefault);
    expect(invoices).toMatchObject({ next: 2, used: true });
    expect(invoices.nextNumber).toMatch(/002$/);
  });

  test("save_number_series, set_default_series a delete_number_series", async () => {
    const { ownerId, claims } = await account("full");
    const saved = data(
      await callTool("save_number_series", claims, {
        name: "Projekty",
        documentType: "invoice",
        template: "P{RRRR}-{NNN}",
        reset: "yearly",
      }),
    );
    expect(listSeries(ownerId).some((s) => s.id === saved.id)).toBe(true);
    data(await callTool("set_default_series", claims, { id: saved.id }));
    expect(listSeries(ownerId).find((s) => s.id === saved.id)?.isDefault).toBe(true);

    const refused = await callTool("delete_number_series", claims, { id: saved.id });
    expect(textOf(refused)).toContain(TEXTS.numberSeries.errors.defaultLocked);
    const old = listSeries(ownerId).find((s) => s.documentType === "invoice" && !s.isDefault)!;
    data(await callTool("delete_number_series", claims, { id: old.id }));
    expect(listSeries(ownerId).some((s) => s.id === old.id)).toBe(false);
  });

  test("set_next_number na obsazené číslo odmítne", async () => {
    const { ownerId, claims, customerId } = await account("issue_send");
    issuedInvoice(ownerId, customerId);
    const series = listSeries(ownerId).find((s) => s.documentType === "invoice" && s.isDefault)!;
    const result = await callTool("set_next_number", claims, { id: series.id, next: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(TEXTS.numberSeries.errors.nextUsed);
    expect(
      data(await callTool("set_next_number", claims, { id: series.id, next: 10 })),
    ).toMatchObject({ id: series.id, next: 10 });
  });

  test("set_next_number vyžaduje issue_send", async () => {
    const { ownerId, claims } = await account("accounting");
    const series = listSeries(ownerId)[0];
    const result = await callTool("set_next_number", claims, { id: series?.id ?? "x", next: 5 });
    expect(result.isError).toBe(true);
    expect(lastCall(ownerId, "set_next_number")).toMatchObject({ requiredLevel: "issue_send" });
  });
});
