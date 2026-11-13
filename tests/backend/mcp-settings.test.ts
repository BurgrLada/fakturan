import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { auditSourceLabel } from "@/lib/audit-labels";
import { setClockForTests } from "@/server/clock";
import { auditLog, user } from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import { DEFAULT_MCP_SETTINGS, MCP_LEVELS, levelAtLeast } from "@/lib/mcp-settings";
import { activeLevel, getMcpSettings, saveMcpSettings } from "@/server/services/mcp-settings";
import { mutate } from "@/server/services/mutation";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-mcp-settings-")));

const db = createTestDb();
const NOW = new Date("2026-11-11T10:00:00Z");
const web = (userId: string) => ({ userId, source: "web" as const });

function newUser(): string {
  const id = `u-${randomUUID()}`;
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: NOW, updatedAt: NOW })
    .run();
  return id;
}

const input = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  level: "read",
  logCalls: true,
  revision: 0,
  ...over,
});

function lastAudit(ownerId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ownerId, ownerId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.id))
    .get();
}

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("nastavení asistentů", () => {
  test("[MCP-050] výchozí nastavení je read, log zapnutý, přístup vypnutý", () => {
    expect(getMcpSettings(newUser())).toEqual(DEFAULT_MCP_SETTINGS);
    expect(DEFAULT_MCP_SETTINGS).toEqual({
      enabled: false,
      level: "read",
      logCalls: true,
      revision: 0,
    });
  });

  test("[MCP-050] uloží každou úroveň", () => {
    const owner = newUser();
    MCP_LEVELS.forEach((level, index) => {
      const saved = saveMcpSettings(web(owner), input({ level, revision: index }));
      expect(saved).toEqual({ enabled: true, level, logCalls: true, revision: index + 1 });
      expect(getMcpSettings(owner)).toEqual(saved);
    });
  });

  test("[MCP-050] odmítne neznámou úroveň", () => {
    const owner = newUser();
    expect(() => saveMcpSettings(web(owner), input({ level: "admin" }))).toThrow(ServiceError);
    expect(() => saveMcpSettings(web(owner), input({ create: true }))).toThrow(ServiceError);
    expect(() => saveMcpSettings(web(owner), { enabled: "ano" })).toThrow(ServiceError);
    expect(getMcpSettings(owner).revision).toBe(0);
    expect(lastAudit(owner, "mcp.settings_changed")).toBeUndefined();
  });

  test("[MCP-010] uložení zvýší revizi, starší revize se odmítne", () => {
    const owner = newUser();
    expect(saveMcpSettings(web(owner), input()).revision).toBe(1);
    expect(() => saveMcpSettings(web(owner), input({ enabled: false, revision: 0 }))).toThrow(
      ServiceError,
    );
    expect(getMcpSettings(owner).enabled).toBe(true);
    expect(saveMcpSettings(web(owner), input({ enabled: false, revision: 1 })).revision).toBe(2);
  });

  test("[MCP-014] [MCP-056] změna úrovně se zapíše do auditu", () => {
    const owner = newUser();
    saveMcpSettings(web(owner), input());
    saveMcpSettings(web(owner), input({ level: "accounting", logCalls: false, revision: 1 }));
    const row = lastAudit(owner, "mcp.settings_changed")!;
    expect(row).toMatchObject({
      source: "web",
      actorId: owner,
      scope: "user",
      entity: "mcp_settings",
      entityId: owner,
      clientId: null,
      clientName: null,
    });
    expect(row.before).toEqual({ enabled: true, level: "read", logCalls: true });
    expect(row.after).toEqual({ enabled: true, level: "accounting", logCalls: false });
  });

  test("[MCP-050] activeLevel je null při vypnutém přístupu", () => {
    expect(activeLevel({ ...DEFAULT_MCP_SETTINGS, level: "full" })).toBeNull();
    expect(activeLevel({ ...DEFAULT_MCP_SETTINGS, enabled: true, level: "drafts" })).toBe("drafts");
  });

  test("[MCP-050] levelAtLeast porovnává pořadí úrovní", () => {
    expect(MCP_LEVELS).toEqual(["read", "drafts", "accounting", "issue_send", "full"]);
    expect(levelAtLeast("accounting", "drafts")).toBe(true);
    expect(levelAtLeast("drafts", "accounting")).toBe(false);
    for (const level of MCP_LEVELS) expect(levelAtLeast(level, level)).toBe(true);
  });

  test("[MCP-015] nastavení je per uživatel", () => {
    const first = newUser();
    const second = newUser();
    saveMcpSettings(web(first), input({ level: "drafts" }));
    expect(getMcpSettings(second)).toMatchObject({ enabled: false, level: "read", revision: 0 });
    saveMcpSettings(web(second), input({ level: "full" }));
    expect(getMcpSettings(first)).toMatchObject({ enabled: true, level: "drafts" });
    expect(() => saveMcpSettings({ userId: null, source: "web" }, input())).toThrow(ServiceError);
  });

  test("[MCP-030] aktér mcp nese klienta do auditu", () => {
    const owner = newUser();
    const actor = {
      userId: owner,
      source: "mcp" as const,
      clientId: "klient-1",
      clientName: "Claude Code",
    };
    mutate(actor, "invoice.save", (_tx, audit) =>
      audit({ entity: "invoice", entityId: "f-1", ownerId: owner, scope: "user" }),
    );
    const row = lastAudit(owner, "invoice.save")!;
    expect(row).toMatchObject({
      source: "mcp",
      actorId: owner,
      clientId: "klient-1",
      clientName: "Claude Code",
    });
    expect(auditSourceLabel(row)).toBe("Asistent: Claude Code");
    expect(auditSourceLabel({ source: "mcp", clientName: null })).toBe(
      "Asistent: Neznámá aplikace",
    );
    expect(auditSourceLabel({ source: "web", clientName: null })).toBe("Web");
  });
});
