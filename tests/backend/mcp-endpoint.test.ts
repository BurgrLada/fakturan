import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { createAuth } from "@/server/auth";
import { setClockForTests } from "@/server/clock";
import { auditLog, rateLimit, user } from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { mcpEndpoint } from "@/server/mcp/server";
import { defineTool, TOOLS } from "@/server/mcp/tool";
import type { McpSettings } from "@/lib/mcp-settings";
import { getMcpSettings, saveMcpSettings } from "@/server/services/mcp-settings";
import { BASE, Browser } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";
import { ISSUER, issueMcpToken, refresh, RESOURCE, serveJwksFrom } from "../helpers/mcp-oauth";

const db = createTestDb();
const OWNER = "majitel@example.cz";
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-mcp-endpoint-"));
const SECRETS = {
  DATA_DIR: dataDir,
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function testEnv(extra: Record<string, string> = {}): Env {
  return parseEnv({ ...SECRETS, ...extra });
}

const env = testEnv();
const auth = createAuth(env);

const echo = defineTool({
  name: "echo",
  title: "Ozvěna",
  description: "Vrátí zadaný text.",
  capability: "read",
  input: z.strictObject({ text: z.string() }),
  output: z.object({ text: z.string() }),
  run: (_ctx, input) => ({ text: input.text }),
  text: (output) => output.text,
});
const echoCreate = defineTool({
  ...echo,
  name: "echo_create",
  description: "Zapíše zadaný text.",
  capability: "create",
});

let browser: Browser;
let ownerId: string;

function setAccess(changes: Partial<Omit<McpSettings, "revision">>) {
  const current = getMcpSettings(ownerId);
  saveMcpSettings({ userId: ownerId, source: "web" }, { ...current, ...changes });
}

// A 2025-era client: no session, no initialize needed, the token on every request (MCP-035).
function post(token: string | null, body: unknown, extra: Record<string, string> = {}) {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

async function rpcResult<T>(response: Response): Promise<T> {
  const body = await response.text();
  const json = body.startsWith("{") ? body : /^data: (.*)$/m.exec(body)![1]!;
  return (JSON.parse(json) as { result: T }).result;
}

const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

beforeAll(async () => {
  browser = new Browser(auth);
  await browser.signUp(OWNER);
  ownerId = db.select({ id: user.id }).from(user).where(eq(user.email, OWNER)).get()!.id;
});

beforeEach(() => {
  db.delete(rateLimit).run();
  setAccess({ enabled: true, level: "drafts" });
  serveJwksFrom(auth);
  TOOLS.push(echo, echoCreate);
});

// Only the test tools are removed: the production tools stay registered.
function unregister(...tools: (typeof TOOLS)[number][]) {
  for (const tool of tools) {
    const index = TOOLS.indexOf(tool);
    if (index >= 0) TOOLS.splice(index, 1);
  }
}

afterEach(() => {
  unregister(echo, echoCreate);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("endpoint /api/mcp", () => {
  test("[MCP-034] bez tokenu 401", async () => {
    const response = await mcpEndpoint(auth, env, post(null, toolsList));
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    // The scope a client asks for comes from here: with offline_access it gets a refresh token.
    expect(challenge).toContain('scope="fakturan offline_access"');

    const garbage = await mcpEndpoint(auth, env, post("neplatny.token.x", toolsList));
    expect(garbage.status).toBe(401);
  });

  test("[MCP-007] token s cizí audience 401", async () => {
    const { accessToken } = await issueMcpToken(auth, browser);
    const claims = decodeJwt(accessToken);
    // Signed by the instance's own keys, so only the audience differs from a valid token.
    const sign = async (aud: string) =>
      (await auth.api.signJWT({ body: { payload: { ...claims, aud } } })).token;

    const foreign = await mcpEndpoint(auth, env, post(await sign(`${BASE}/api/jinde`), toolsList));
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get("www-authenticate")).toContain("resource_metadata=");

    const own = await mcpEndpoint(auth, env, post(await sign(RESOURCE), toolsList));
    expect(own.status).toBe(200);
    expect(claims.iss).toBe(ISSUER);
  });

  test("[MCP-007] token s cizím issuerem 401 a bez scope fakturan 403", async () => {
    const { accessToken } = await issueMcpToken(auth, browser);
    const claims = decodeJwt(accessToken);
    const sign = async (payload: Record<string, unknown>) =>
      (await auth.api.signJWT({ body: { payload: { ...claims, ...payload } } })).token;

    const foreignIssuer = await mcpEndpoint(
      auth,
      env,
      post(await sign({ iss: "https://jinde.example/api/auth" }), toolsList),
    );
    expect(foreignIssuer.status).toBe(401);
    expect(foreignIssuer.headers.get("www-authenticate")).toContain("resource_metadata=");

    const noScope = await mcpEndpoint(
      auth,
      env,
      post(await sign({ scope: "openid profile" }), toolsList),
    );
    expect(noScope.status).toBe(403);

    expect((await mcpEndpoint(auth, env, post(await sign({}), toolsList))).status).toBe(200);
  });

  test("[MCP-010] s vypnutým přístupem obnova tokenu projde, volání nástroje ne", async () => {
    const { refreshToken, clientId } = await issueMcpToken(auth, browser);
    setAccess({ enabled: false });
    const renewed = await refresh(auth, clientId, refreshToken!);
    const response = await mcpEndpoint(
      auth,
      env,
      post(renewed.access_token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "ahoj" } },
      }),
    );
    expect(response.status).toBe(200);
    expect(await rpcResult(response)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: TEXTS.mcp.tools.disabled }],
    });
  });

  test("[MCP-035][MCP-025] tools/list s platným tokenem", async () => {
    const { accessToken } = await issueMcpToken(auth, browser);
    setAccess({ level: "read" });

    const response = await mcpEndpoint(auth, env, post(accessToken, toolsList));
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const { tools } = await rpcResult<{ tools: { name: string; description: string }[] }>(response);
    // [MCP-025] A tool without its capability is listed too, with a note where to switch it on.
    const ours = tools.filter((tool) => tool.name.startsWith("echo"));
    expect(ours.map((tool) => [tool.name, tool.description])).toEqual([
      ["echo", "Vrátí zadaný text."],
      ["echo_create", "Zapíše zadaný text. (v Nastavení › Asistenti vypnuto)"],
    ]);

    // Stateless: another request with the same token needs no session or initialize.
    const call = await mcpEndpoint(
      auth,
      env,
      post(accessToken, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "ahoj" } },
      }),
    );
    expect(call.status).toBe(200);
    expect(await rpcResult(call)).toMatchObject({
      content: [{ type: "text", text: "ahoj" }],
      structuredContent: { text: "ahoj" },
    });
  });

  test("[MCP-002] klient na protokolu 2026-07-28 dostane seznam nástrojů", async () => {
    const { accessToken } = await issueMcpToken(auth, browser);
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
    };
    const response = await mcpEndpoint(
      auth,
      env,
      post(
        accessToken,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      ),
    );
    const body = await response.clone().text();
    expect(response.status, body).toBe(200);
    const { tools } = await rpcResult<{ tools: { name: string }[] }>(response);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["echo", "echo_create"]));
  });

  test("[MCP-032] 61. volání za minutu", async () => {
    const start = new Date("2026-11-11T10:00:00Z");
    setClockForTests({ now: () => start });
    try {
      const first = await issueMcpToken(auth, browser);
      const second = await issueMcpToken(auth, browser, "Jiný asistent");
      // Every request counts, a refused tool call too: the limit sits in front of the tools.
      for (let i = 0; i < 60; i += 1) {
        expect((await mcpEndpoint(auth, env, post(first.accessToken, toolsList))).status).toBe(200);
      }
      const limited = await mcpEndpoint(auth, env, post(first.accessToken, toolsList));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");

      // The limit is per user and client: another assistant of the same user still works.
      expect((await mcpEndpoint(auth, env, post(second.accessToken, toolsList))).status).toBe(200);
      const denials = db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "rate_limit.exceeded"), eq(auditLog.ownerId, ownerId)))
        .all();
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({ source: "mcp", clientId: first.clientId });

      setClockForTests({ now: () => new Date(start.getTime() + 60_000) });
      expect((await mcpEndpoint(auth, env, post(first.accessToken, toolsList))).status).toBe(200);
    } finally {
      setClockForTests(null);
    }
  });

  test("[MCP-009] demo 404", async () => {
    const { accessToken } = await issueMcpToken(auth, browser);
    const demo = testEnv({
      DEMO_MODE: "1",
      DEMO_EMAIL: "ukazka@fakturan.example",
      DEMO_PASSWORD: "ukazka-heslo",
    });
    for (const off of [demo, testEnv({ MCP_ENABLED: "false" })]) {
      expect((await mcpEndpoint(auth, off, post(accessToken, toolsList))).status).toBe(404);
      expect((await mcpEndpoint(auth, off, post(null, toolsList))).status).toBe(404);
    }
  });

  test("[MCP-035] trasa Next obslouží jen POST", async () => {
    for (const [key, value] of Object.entries(SECRETS)) vi.stubEnv(key, value);
    const route = await import("@/app/api/mcp/route");
    expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))).toEqual(["POST"]);
    const response = await route.POST(post(null, toolsList));
    expect(response.status).toBe(401);
  });
});
