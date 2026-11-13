import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { auditLog, invoice, mcpCallLog, user } from "@/server/db/schema";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { saveCustomer } from "@/server/services/customers";
import { MCP_CALL_LOG_DAYS, purgeMcpCallLog, recordMcpCall } from "@/server/mcp-usage";
import { clearMcpCallLog, listMcpCalls } from "@/server/services/mcp-call-log";
import { disconnectMcpClient } from "@/server/services/mcp-connections";
import { getMcpSettings, saveMcpSettings } from "@/server/services/mcp-settings";
import { saveSupplier } from "@/server/services/supplier";
import { deleteUser } from "@/server/services/users";
import { createTestDb } from "../helpers/db";
import { callTool, mcpAccount } from "../helpers/mcp-tools";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const db = createTestDb();
const web = (userId: string) => ({ userId, source: "web" as const });
const SECRET = "tajné heslo 1234";

let adminId: string;

beforeAll(async () => {
  // The first account of the instance is the admin, who can delete the others.
  adminId = (await mcpAccount(db)).ownerId;
});

afterEach(() => vi.restoreAllMocks());

// A customer and a bank account, so a draft can be created through the tool.
function prepare(ownerId: string): string {
  saveSupplier(web(ownerId), {
    name: "Jan Novák",
    street: "Dlouhá 1",
    city: "Praha",
    zip: "110 00",
    country: "Česká republika",
    ico: "27082440",
    dic: "",
    email: "",
    phone: "",
    web: "",
    registryNote: "",
    contactPerson: "",
    vatIdentified: false,
    footerText: "",
    notVatPayerCs: "Nejsem plátce DPH.",
    notVatPayerEn: "I am not a VAT payer.",
  });
  saveBankAccount(web(ownerId), {
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });
  return saveCustomer(web(ownerId), {
    name: "Alfa s.r.o.",
    street: "Krátká 2",
    city: "Brno",
    zip: "602 00",
    country: "Česká republika",
    ico: "",
    dic: "",
    email: "",
    extraEmails: [],
    phone: "",
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
  }).id;
}

const draft = (customerId: string) => ({
  customerId,
  note: SECRET,
  lines: [{ name: "Konzultace", quantity: "1", unitPrice: "1000" }],
});

function logOf(ownerId: string) {
  return db
    .select()
    .from(mcpCallLog)
    .where(eq(mcpCallLog.ownerId, ownerId))
    .orderBy(desc(mcpCallLog.id))
    .all();
}

describe("zápis logu v obalu nástroje", () => {
  test("[MCP-061] úspěšné volání zapíše ok", async () => {
    const { ownerId, claims } = await mcpAccount(db, { level: "drafts" });
    const result = await callTool("create_draft_invoice", claims, draft(prepare(ownerId)));
    expect(result.isError).toBeFalsy();
    const [row] = logOf(ownerId);
    expect(row).toMatchObject({
      tool: "create_draft_invoice",
      outcome: "ok",
      reason: null,
      requiredLevel: null,
      clientId: claims.azp,
      clientName: "Claude Code",
    });
    const audit = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, ownerId), eq(auditLog.action, "invoice.save")))
      .get();
    expect(row!.requestId).toBe(audit?.requestId);
  });

  test("[MCP-061] [MCP-067] odmítnutí kvůli úrovni zapíše denied/level s required_level", async () => {
    const { ownerId, claims } = await mcpAccount(db);
    await callTool("create_draft_invoice", claims, draft("x"));
    expect(logOf(ownerId)[0]).toMatchObject({
      tool: "create_draft_invoice",
      outcome: "denied",
      reason: "level",
      requiredLevel: "drafts",
    });
  });

  test("[MCP-061] vypnutý přístup zapíše denied/disabled", async () => {
    const { ownerId, claims } = await mcpAccount(db);
    saveMcpSettings(web(ownerId), { ...getMcpSettings(ownerId), enabled: false });
    await callTool("get_overview", claims, {});
    expect(logOf(ownerId)[0]).toMatchObject({
      outcome: "denied",
      reason: "disabled",
      requiredLevel: null,
    });
  });

  test("[MCP-061] odpojený klient zapíše denied/not_connected", async () => {
    const { ownerId, claims } = await mcpAccount(db);
    disconnectMcpClient(web(ownerId), claims.azp ?? claims.client_id!);
    await callTool("get_overview", claims, {});
    expect(logOf(ownerId)[0]).toMatchObject({ outcome: "denied", reason: "not_connected" });
  });

  test("[MCP-067] neplatný vstup zapíše error/invalid_input bez required_level", async () => {
    const { ownerId, claims } = await mcpAccount(db, { level: "drafts" });
    await callTool("create_draft_invoice", claims, { lines: "nic" });
    expect(logOf(ownerId)[0]).toMatchObject({
      outcome: "error",
      reason: "invalid_input",
      requiredLevel: null,
    });
  });

  test("[MCP-061] chyba služby zapíše error/service_error", async () => {
    const { ownerId, claims } = await mcpAccount(db, { level: "drafts" });
    prepare(ownerId);
    const result = await callTool("create_draft_invoice", claims, draft("cizi-zakaznik"));
    expect(result.isError).toBe(true);
    expect(logOf(ownerId)[0]).toMatchObject({ outcome: "error", reason: "service_error" });
  });

  test("[MCP-062] s vypnutým logem se nezapíše nic, audit mutace ano", async () => {
    const { ownerId, claims } = await mcpAccount(db, { level: "drafts", logCalls: false });
    const result = await callTool("create_draft_invoice", claims, draft(prepare(ownerId)));
    expect(result.isError).toBeFalsy();
    await callTool("get_overview", claims, {});
    expect(logOf(ownerId)).toHaveLength(0);
    const audit = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, ownerId), eq(auditLog.action, "invoice.save")))
      .get();
    expect(audit?.source).toBe("mcp");
  });

  test("[MCP-060] log neobsahuje argumenty", async () => {
    const { ownerId, claims } = await mcpAccount(db, { level: "drafts" });
    await callTool("create_draft_invoice", claims, draft(prepare(ownerId)));
    const rows = logOf(ownerId);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain("Konzultace");
  });

  test("[MCP-061] selhání zápisu logu nezmění výsledek", async () => {
    const { ownerId, claims } = await mcpAccount(db, { level: "drafts" });
    const customerId = prepare(ownerId);
    const insert = db.insert.bind(db);
    vi.spyOn(db, "insert").mockImplementation(((table: unknown) => {
      if (table === mcpCallLog) throw new Error("disk je plný");
      return insert(table as never);
    }) as never);
    const result = await callTool("create_draft_invoice", claims, draft(customerId));
    expect(result.isError).toBeFalsy();
    expect(db.select().from(invoice).where(eq(invoice.userId, ownerId)).all()).toHaveLength(1);
    expect(logOf(ownerId)).toHaveLength(0);
  });

  test("[MCP-061] neznámý sub se nezapisuje", async () => {
    const before = db.select().from(mcpCallLog).all().length;
    const result = await callTool("get_overview", { sub: "neexistuje", azp: "nikdo" }, {});
    expect(result.isError).toBe(true);
    expect(db.select().from(mcpCallLog).all()).toHaveLength(before);
  });
});

describe("výpis, mazání a úklid logu", () => {
  const entry = (ownerId: string, at: Date, outcome: "ok" | "denied" = "ok") => ({
    ownerId,
    clientId: "klient",
    clientName: "Claude Code",
    tool: "get_overview",
    outcome,
    reason: outcome === "ok" ? null : ("level" as const),
    requiredLevel: outcome === "ok" ? null : ("drafts" as const),
    requestId: crypto.randomUUID(),
    at,
  });

  test("[MCP-063] výpis je nejnovější nahoře, po 50, s filtrem výsledku", async () => {
    const { ownerId } = await mcpAccount(db);
    const start = Date.parse("2026-11-01T08:00:00Z");
    for (let i = 0; i < 55; i++) {
      recordMcpCall(entry(ownerId, new Date(start + i * 60_000), i % 5 === 0 ? "denied" : "ok"));
    }
    const first = listMcpCalls(ownerId, { page: 1 });
    expect(first.rows).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    expect(first.rows[0]!.at.getTime()).toBe(start + 54 * 60_000);
    expect(listMcpCalls(ownerId, { page: 2 }).rows).toHaveLength(5);
    const denied = listMcpCalls(ownerId, { page: 1, outcome: "denied" });
    expect(denied.rows).toHaveLength(11);
    expect(listMcpCalls(ownerId, { page: 1, clientId: "jiny" }).rows).toHaveLength(0);
  });

  test("[MCP-064] tlačítko Smazat log smaže jen vlastní log a zapíše audit", async () => {
    const mine = await mcpAccount(db);
    const other = await mcpAccount(db);
    recordMcpCall(entry(mine.ownerId, new Date()));
    recordMcpCall(entry(other.ownerId, new Date()));
    clearMcpCallLog(web(mine.ownerId));
    expect(logOf(mine.ownerId)).toHaveLength(0);
    expect(logOf(other.ownerId)).toHaveLength(1);
    const audit = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, mine.ownerId), eq(auditLog.action, "mcp.call_log_cleared")))
      .get();
    expect(audit).toBeDefined();
  });

  test("[MCP-064] purge smaže záznamy starší než 90 dní a nechá novější", async () => {
    const { ownerId } = await mcpAccount(db);
    const now = new Date("2026-11-12T12:00:00Z");
    const day = 86_400_000;
    expect(MCP_CALL_LOG_DAYS).toBe(90);
    recordMcpCall(entry(ownerId, new Date(now.getTime() - 91 * day)));
    recordMcpCall(entry(ownerId, new Date(now.getTime() - 89 * day)));
    purgeMcpCallLog(now);
    const rows = logOf(ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at.getTime()).toBe(now.getTime() - 89 * day);
  });

  test("[MCP-065] smazání uživatele smaže jeho log", async () => {
    const { ownerId } = await mcpAccount(db);
    recordMcpCall(entry(ownerId, new Date()));
    const email = db.select({ email: user.email }).from(user).where(eq(user.id, ownerId)).get()!;
    deleteUser(web(adminId), ownerId, email.email);
    expect(logOf(ownerId)).toHaveLength(0);
  });

  test("[MCP-062] zápis přes recordMcpCall respektuje vypnutý log", async () => {
    const { ownerId } = await mcpAccount(db, { logCalls: false });
    recordMcpCall(entry(ownerId, new Date()));
    expect(logOf(ownerId)).toHaveLength(0);
  });
});
