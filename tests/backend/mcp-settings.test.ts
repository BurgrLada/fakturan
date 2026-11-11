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
import {
  AVAILABLE_CAPABILITIES,
  getMcpSettings,
  saveMcpSettings,
} from "@/server/services/mcp-settings";
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
  read: true,
  create: false,
  edit: false,
  issue: false,
  send: false,
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
  test("[MCP-010] výchozí stav vypnuto, Číst zapnuto", () => {
    expect(getMcpSettings(newUser())).toEqual({
      enabled: false,
      read: true,
      create: false,
      edit: false,
      issue: false,
      send: false,
      revision: 0,
    });
    expect(AVAILABLE_CAPABILITIES).toEqual(["read", "create"]);
  });

  test("[MCP-010] uložení zapne přístup a zvýší revizi, starší revize se odmítne", () => {
    const owner = newUser();
    const saved = saveMcpSettings(web(owner), input({ create: true }));
    expect(saved).toEqual({
      enabled: true,
      read: true,
      create: true,
      edit: false,
      issue: false,
      send: false,
      revision: 1,
    });
    expect(getMcpSettings(owner)).toEqual(saved);
    expect(() => saveMcpSettings(web(owner), input({ enabled: false, revision: 0 }))).toThrow(
      ServiceError,
    );
    expect(getMcpSettings(owner).enabled).toBe(true);
    expect(saveMcpSettings(web(owner), input({ enabled: false, revision: 1 })).revision).toBe(2);
  });

  test("[MCP-011] nejde zapnout Upravovat, Vystavovat, Odesílat", () => {
    const owner = newUser();
    for (const capability of ["edit", "issue", "send"]) {
      expect(() => saveMcpSettings(web(owner), input({ [capability]: true }))).toThrow(
        ServiceError,
      );
    }
    expect(() => saveMcpSettings(web(owner), { enabled: "ano" })).toThrow(ServiceError);
    expect(getMcpSettings(owner).revision).toBe(0);
    expect(lastAudit(owner, "mcp.settings_changed")).toBeUndefined();
  });

  test("[MCP-014] změna se audituje", () => {
    const owner = newUser();
    saveMcpSettings(web(owner), input());
    saveMcpSettings(web(owner), input({ read: false, create: true, revision: 1 }));
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
    expect(row.before).toMatchObject({ enabled: true, read: true, create: false });
    expect(row.after).toMatchObject({ enabled: true, read: false, create: true });
  });

  test("[MCP-015] nastavení je per uživatel", () => {
    const first = newUser();
    const second = newUser();
    saveMcpSettings(web(first), input({ create: true }));
    expect(getMcpSettings(second)).toMatchObject({ enabled: false, create: false, revision: 0 });
    saveMcpSettings(web(second), input({ read: false }));
    expect(getMcpSettings(first)).toMatchObject({ enabled: true, read: true, create: true });
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
