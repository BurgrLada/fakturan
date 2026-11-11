import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import {
  auditLog,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  user,
} from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import {
  disconnectMcpClient,
  isMcpConnected,
  listMcpConnections,
  touchMcpConnection,
} from "@/server/services/mcp-connections";
import { createTestDb } from "../helpers/db";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-mcp-connections-")));

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

function newClient(
  name: string | null,
  redirectUri: string,
  clientId: string = randomUUID(),
): string {
  db.insert(oauthClient)
    .values({
      id: randomUUID(),
      clientId,
      name,
      redirectUris: JSON.stringify([redirectUri]),
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  return clientId;
}

// What the provider stores after a consent and a code exchange: the consent, a refresh token and an
// opaque access token tied to it (JWT access tokens are not stored at all).
function connect(userId: string, clientId: string, at = NOW): void {
  db.insert(oauthConsent)
    .values({
      id: randomUUID(),
      clientId,
      userId,
      scopes: JSON.stringify(["fakturan", "offline_access"]),
      createdAt: at,
      updatedAt: at,
    })
    .run();
  const refreshId = randomUUID();
  db.insert(oauthRefreshToken)
    .values({
      id: refreshId,
      token: randomUUID(),
      clientId,
      userId,
      scopes: JSON.stringify(["fakturan"]),
      expiresAt: new Date(at.getTime() + 86_400_000),
      createdAt: at,
    })
    .run();
  db.insert(oauthAccessToken)
    .values({
      id: randomUUID(),
      token: randomUUID(),
      clientId,
      userId,
      refreshId,
      scopes: JSON.stringify(["fakturan"]),
      expiresAt: new Date(at.getTime() + 900_000),
      createdAt: at,
    })
    .run();
}

function rowsOf(userId: string, clientId: string) {
  const n = (table: typeof oauthConsent | typeof oauthRefreshToken | typeof oauthAccessToken) =>
    db
      .select({ n: count() })
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.clientId, clientId)))
      .get()!.n;
  return { consent: n(oauthConsent), refresh: n(oauthRefreshToken), access: n(oauthAccessToken) };
}

function auditCount(): number {
  return db.select({ n: count() }).from(auditLog).get()!.n;
}

beforeEach(() => setClockForTests({ now: () => NOW }));
afterEach(() => setClockForTests(null));

describe("propojení asistentů", () => {
  test("[MCP-013] seznam ukáže název, doménu, připojení a poslední použití", () => {
    const owner = newUser();
    const local = newClient("Claude Code", "http://127.0.0.1:33418/callback");
    const web1 = newClient("  Claude  ", "https://claude.ai/api/mcp/auth_callback");
    const cimd = newClient(
      "ChatGPT",
      "https://chatgpt.com/connector/callback",
      "https://openai.example/client.json",
    );
    const foreign = newClient("Cizí", "https://cizi.example/cb");
    connect(owner, local, new Date("2026-11-01T08:00:00Z"));
    connect(owner, web1, new Date("2026-11-05T08:00:00Z"));
    connect(owner, cimd, new Date("2026-11-03T08:00:00Z"));
    connect(newUser(), foreign);
    touchMcpConnection(owner, web1, NOW);

    const list = listMcpConnections(owner);
    expect(list).toEqual([
      {
        clientId: web1,
        name: "Claude",
        host: "claude.ai",
        connectedAt: new Date("2026-11-05T08:00:00Z"),
        lastUsedAt: NOW,
      },
      {
        clientId: cimd,
        name: "ChatGPT",
        host: "openai.example",
        connectedAt: new Date("2026-11-03T08:00:00Z"),
        lastUsedAt: null,
      },
      {
        clientId: local,
        name: "Claude Code",
        host: "aplikace na tomto počítači",
        connectedAt: new Date("2026-11-01T08:00:00Z"),
        lastUsedAt: null,
      },
    ]);
    expect(isMcpConnected(owner, local)).toBe(true);
    expect(isMcpConnected(owner, foreign)).toBe(false);
  });

  test("[MCP-013] odpojení smaže souhlas a tokeny jen daného klienta a uživatele", () => {
    const owner = newUser();
    const other = newUser();
    const client = newClient("Claude Code", "http://127.0.0.1:33418/callback");
    const second = newClient("Claude", "https://claude.ai/api/mcp/auth_callback");
    connect(owner, client);
    connect(owner, second);
    connect(other, client);

    disconnectMcpClient(web(owner), client);

    expect(rowsOf(owner, client)).toEqual({ consent: 0, refresh: 0, access: 0 });
    expect(rowsOf(owner, second)).toEqual({ consent: 1, refresh: 1, access: 1 });
    expect(rowsOf(other, client)).toEqual({ consent: 1, refresh: 1, access: 1 });
    expect(isMcpConnected(owner, client)).toBe(false);
    expect(isMcpConnected(other, client)).toBe(true);
    // The client itself is instance-wide and stays (MCP-042).
    expect(
      db.select().from(oauthClient).where(eq(oauthClient.clientId, client)).get(),
    ).toBeTruthy();

    const row = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ownerId, owner), eq(auditLog.action, "mcp.disconnected")))
      .get()!;
    expect(row).toMatchObject({
      source: "web",
      actorId: owner,
      entity: "mcp_client",
      entityId: client,
      scope: "user",
    });
    expect(row.before).toMatchObject({ clientId: client, name: "Claude Code" });

    // Another account cannot disconnect what is not its own, and nothing changes.
    expect(() => disconnectMcpClient(web(owner), client)).toThrow(ServiceError);
    expect(() => disconnectMcpClient(web(newUser()), second)).toThrow(ServiceError);
    expect(rowsOf(owner, second).consent).toBe(1);
  });

  test("[MCP-041] touch zapisuje nejvýš jednou za minutu", () => {
    const owner = newUser();
    const client = newClient("Claude Code", "http://127.0.0.1:33418/callback");
    connect(owner, client);
    const audits = auditCount();
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
    const lastUsed = () => listMcpConnections(owner)[0]!.lastUsedAt;

    setClockForTests({ now: () => at(0) });
    touchMcpConnection(owner, client, at(0));
    expect(lastUsed()).toEqual(at(0));
    touchMcpConnection(owner, client, at(30));
    touchMcpConnection(owner, client, at(59));
    expect(lastUsed()).toEqual(at(0));
    touchMcpConnection(owner, client, at(60));
    expect(lastUsed()).toEqual(at(60));
    touchMcpConnection(owner, client, at(119));
    expect(lastUsed()).toEqual(at(60));
    // Outside the audit (MCP-041), and a pair without a connection writes nothing.
    touchMcpConnection(newUser(), client, at(500));
    expect(auditCount()).toBe(audits);
  });
});
