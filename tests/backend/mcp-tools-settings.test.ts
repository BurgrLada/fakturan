import type { CallToolResult } from "@modelcontextprotocol/server";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { TEXTS } from "@/lib/texts";
import { mcpCallLog } from "@/server/db/schema";
import { getAutomation, setAutomation } from "@/server/services/automation";
import { getEmailTemplate } from "@/server/services/email-templates";
import { getPreferences } from "@/server/services/preferences";
import { listReminderRules, saveReminderRule } from "@/server/services/reminders";
import { getSupplier } from "@/server/services/supplier";
import { TOOLS } from "@/server/mcp/tool";
import { createTestDb } from "../helpers/db";
import { seedSupplier, webActor } from "../helpers/fixtures-mail";
import { callTool, lastAuditSource, mcpAccount } from "../helpers/mcp-tools";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const db = createTestDb();
const NOT_FOUND = /nenalezen|neexistuje/i;
const APPEARANCE = [
  "designId",
  "accentColor",
  "surfaceColor",
  "textColor",
  "lineColor",
  "logoPosition",
];

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
  return { ownerId, claims };
}

const lastCall = (ownerId: string, tool: string) =>
  db
    .select()
    .from(mcpCallLog)
    .where(and(eq(mcpCallLog.ownerId, ownerId), eq(mcpCallLog.tool, tool)))
    .orderBy(desc(mcpCallLog.id))
    .get();

const tool = (name: string) => TOOLS.find((def) => def.name === name);
const inputKeys = (name: string) => Object.keys((tool(name)!.input as any).shape);

describe("dodavatel", () => {
  test("get_supplier vrátí údaje dodavatele na úrovni čtení", async () => {
    const { claims } = await account("read");
    const got = data(await callTool("get_supplier", claims, {}));
    expect(got).toMatchObject({ name: "Jan Novák", ico: "27082440", vatIdentified: false });
    expect(got.missing).toEqual([]);
  });

  test("save_supplier změní jen uvedená pole a audit má zdroj mcp", async () => {
    const { ownerId, claims } = await account("accounting");
    data(await callTool("save_supplier", claims, { phone: "777 123 456" }));
    const row = getSupplier(ownerId)!;
    expect(row.phone).toBe("777 123 456");
    expect(row.name).toBe("Jan Novák");
    expect(row.notVatPayerCs).toBe("Nejsem plátce DPH.");
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
    expect(inputKeys("save_supplier").some((key) => /logo|signature|image/i.test(key))).toBe(false);
  });

  test("save_supplier na úrovni Koncepty odmítne s potřebnou úrovní", async () => {
    const { ownerId, claims } = await account("drafts");
    const result = await callTool("save_supplier", claims, { phone: "1" });
    expect(result.isError).toBe(true);
    expect(lastCall(ownerId, "save_supplier")).toMatchObject({
      outcome: "denied",
      requiredLevel: "accounting",
    });
  });
});

describe("výchozí hodnoty", () => {
  test("get_preferences nevrací klíče vzhledu", async () => {
    const { claims } = await account("read");
    const got = data(await callTool("get_preferences", claims, {}));
    expect(got.dueDays).toBe(getPreferences((await account()).ownerId).dueDays);
    for (const key of APPEARANCE) expect(got).not.toHaveProperty(key);
  });

  test("save_preferences uloží patch, limity jako částku a kurz jako desetinné číslo", async () => {
    const { ownerId, claims } = await account("accounting");
    data(
      await callTool("save_preferences", claims, {
        dueDays: 30,
        turnoverVatLimit: "2 000 000",
        fixedRates: { EUR: "25,1" },
      }),
    );
    const prefs = getPreferences(ownerId);
    expect(prefs.dueDays).toBe(30);
    expect(prefs.turnoverVatLimitMinor).toBe(200_000_000);
    expect(prefs.fixedRates).toEqual({ EUR: 25_100_000 });
    expect(lastAuditSource(db, ownerId)).toBe("mcp");

    const got = data(await callTool("get_preferences", claims, {}));
    expect(got.turnoverVatLimit).toMatchObject({ amount: 200_000_000, currency: "CZK" });
    expect(got.fixedRates).toEqual({ EUR: "25,1" });

    const wrong = await callTool("save_preferences", claims, { fixedRates: { EUR: "x" } });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain(TEXTS.preferences.fixedRates.invalid("EUR"));
  });

  test("save_preferences s designId odmítne jako neznámé pole", async () => {
    const { ownerId, claims } = await account("full");
    const before = getPreferences(ownerId).designId;
    const result = await callTool("save_preferences", claims, { designId: "jiny" });
    expect(result.isError).toBe(true);
    expect(getPreferences(ownerId).designId).toBe(before);
    for (const key of APPEARANCE) expect(inputKeys("save_preferences")).not.toContain(key);
  });
});

describe("automatizace", () => {
  test("disable_automation vypne automatizaci a audit má zdroj mcp", async () => {
    const { ownerId, claims } = await account("accounting");
    setAutomation(webActor(ownerId), "reminders", true, { confirmed: true });
    const got = data(await callTool("disable_automation", claims, { key: "reminders" }));
    expect(got.reminders).toBe(false);
    expect(getAutomation(ownerId).reminders).toBe(false);
    expect(lastAuditSource(db, ownerId)).toBe("mcp");
    expect(inputKeys("disable_automation")).toEqual(["key"]);
  });

  test("pause_automation pozastaví automatizace a obnovení přes asistenta neexistuje", async () => {
    const { ownerId, claims } = await account("accounting");
    expect(data(await callTool("pause_automation", claims, {})).paused).toBe(true);
    expect(getAutomation(ownerId).paused).toBe(true);
    expect(tool("resume_automation")).toBeUndefined();
    expect(tool("enable_automation")).toBeUndefined();
  });

  test("get_automation a nastavení pošty vlastníkovi", async () => {
    const { ownerId, claims } = await account("accounting");
    expect(data(await callTool("get_automation", claims, {}))).toMatchObject({
      reminders: false,
      sendTime: "09:00",
    });
    data(await callTool("set_send_time", claims, { time: "07:30" }));
    data(await callTool("set_daily_digest", claims, { enabled: true }));
    data(await callTool("set_period_summary", claims, { mode: "monthly" }));
    data(await callTool("set_tax_reminder", claims, { enabled: true }));
    data(await callTool("set_limit_mail", claims, { enabled: true }));
    expect(getAutomation(ownerId)).toMatchObject({
      sendTime: "07:30",
      dailyDigest: true,
      periodSummary: "monthly",
      taxReminder: true,
      limitMail: true,
    });
    const wrong = await callTool("set_send_time", claims, { time: "25:00" });
    expect(wrong.isError).toBe(true);
    expect(getAutomation(ownerId).sendTime).toBe("07:30");
  });
});

describe("upomínky", () => {
  test("save_reminder_rule založí a upraví pravidlo, delete_reminder_rule vyžaduje plný přístup", async () => {
    const { ownerId, claims } = await account("accounting");
    const saved = data(await callTool("save_reminder_rule", claims, { offsetDays: 7 }));
    const listed = data(await callTool("list_reminder_rules", claims, {}));
    expect(listed.rules.map((rule: Data) => [rule.id, rule.offsetDays])).toEqual([[saved.id, 7]]);

    const texts = { cs: { subject: "Připomínka {{cislo_faktury}}", body: "Zbývá {{zbyva}}." } };
    data(await callTool("save_reminder_rule", claims, { id: saved.id, texts }));
    const [rule] = listReminderRules(ownerId);
    expect(rule).toMatchObject({ offsetDays: 7, texts });

    const denied = await callTool("delete_reminder_rule", claims, { id: saved.id });
    expect(denied.isError).toBe(true);
    expect(lastCall(ownerId, "delete_reminder_rule")).toMatchObject({ requiredLevel: "full" });
  });

  test("[MCP-074] cizí pravidlo upomínky se chová jako neexistující", async () => {
    const other = await account();
    const { id } = saveReminderRule(webActor(other.ownerId), { offsetDays: 3, texts: null });
    const { claims } = await account("full");
    const edited = await callTool("save_reminder_rule", claims, { id, offsetDays: 5 });
    expect(textOf(edited)).toMatch(NOT_FOUND);
    const deleted = await callTool("delete_reminder_rule", claims, { id });
    expect(textOf(deleted)).toMatch(NOT_FOUND);
    expect(listReminderRules(other.ownerId)).toHaveLength(1);
  });

  test("delete_reminder_rule na plném přístupu pravidlo smaže", async () => {
    const { ownerId, claims } = await account("full");
    const { id } = saveReminderRule(webActor(ownerId), { offsetDays: 3, texts: null });
    data(await callTool("delete_reminder_rule", claims, { id }));
    expect(listReminderRules(ownerId)).toEqual([]);
  });
});

describe("e-mailové šablony", () => {
  test("uložení, čtení a návrat k výchozímu znění", async () => {
    const { ownerId, claims } = await account("accounting");
    const builtIn = getEmailTemplate(ownerId, "invoice", "cs");
    const list = data(await callTool("list_email_templates", claims, {}));
    expect(list.templates).toContainEqual(
      expect.objectContaining({ kind: "invoice", language: "cs", custom: false }),
    );

    data(
      await callTool("save_email_template", claims, {
        kind: "invoice",
        language: "cs",
        subject: "Faktura {{cislo_faktury}}",
      }),
    );
    const got = data(
      await callTool("get_email_template", claims, { kind: "invoice", language: "cs" }),
    );
    expect(got).toMatchObject({
      subject: "Faktura {{cislo_faktury}}",
      body: builtIn.body,
      custom: true,
    });
    expect(lastAuditSource(db, ownerId)).toBe("mcp");

    const reset = data(
      await callTool("reset_email_template", claims, { kind: "invoice", language: "cs" }),
    );
    expect(reset).toMatchObject({ subject: builtIn.subject, custom: false });
    expect(getEmailTemplate(ownerId, "invoice", "cs")).toEqual(builtIn);
  });
});
