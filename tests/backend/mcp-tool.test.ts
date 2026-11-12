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
import { auditLog, customer, oauthConsent, rateLimit, user } from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { McpToolError } from "@/server/mcp/errors";
import { mcpEndpoint } from "@/server/mcp/server";
import { defineTool, runTool, TOOLS, type ToolDef } from "@/server/mcp/tool";
import { ServiceError } from "@/server/services/access";
import { saveCustomer } from "@/server/services/customers";
import { disconnectMcpClient } from "@/server/services/mcp-connections";
import type { McpSettings } from "@/lib/mcp-settings";
import { getMcpSettings, saveMcpSettings } from "@/server/services/mcp-settings";
import { BASE, Browser } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";
import { issueMcpToken, RESOURCE, serveJwksFrom } from "../helpers/mcp-oauth";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: sentry.captureException }));

const db = createTestDb();
const T = TEXTS.mcp.tools;
const OWNER = "majitel@example.cz";
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-mcp-tool-"));

function testEnv(extra: Record<string, string> = {}): Env {
  return parseEnv({
    DATA_DIR: dataDir,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ...extra,
  });
}

const env = testEnv();
const auth = createAuth(env);

// The test tools stay here, not in the production registry: one reads, one writes through a service.
const echoInput = z.strictObject({ text: z.string().min(1) });
const echoOutput = z.object({ text: z.string(), ownerId: z.string() });
const echoRun = vi.fn((ctx: { ownerId: string }, input: { text: string }) => ({
  text: input.text,
  ownerId: ctx.ownerId,
}));
const echo = defineTool({
  name: "echo",
  title: "Ozvěna",
  description: "Vrátí zadaný text.",
  capability: "read",
  input: echoInput,
  output: echoOutput,
  run: echoRun,
  text: (output) => output.text,
});

const createCustomer = defineTool({
  name: "echo_create",
  title: "Ozvěna se zápisem",
  description: "Založí zákazníka se zadaným názvem.",
  capability: "create",
  input: echoInput,
  output: z.object({ id: z.string() }),
  run: (ctx, input) => ({
    id: saveCustomer(ctx.actor, {
      name: input.text,
      street: "",
      city: "",
      zip: "",
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
    }).id,
  }),
  text: (output) => `Zákazník ${output.id}`,
});

let browser: Browser;
let ownerId: string;

function setAccess(changes: Partial<Omit<McpSettings, "revision">>) {
  const current = getMcpSettings(ownerId);
  saveMcpSettings({ userId: ownerId, source: "web" }, { ...current, ...changes });
}

async function connect(clientName = "Claude Code") {
  const token = await issueMcpToken(auth, browser, clientName);
  const claims = decodeJwt(token.accessToken) as { sub: string; azp?: string };
  return { ...token, claims };
}

function textOf(result: { content?: unknown }): string {
  return ((result.content as { type: string; text: string }[])[0] ?? { text: "" }).text;
}

beforeAll(async () => {
  // The first account on an empty instance needs no invitation.
  browser = new Browser(auth);
  await browser.signUp(OWNER);
  ownerId = db.select({ id: user.id }).from(user).where(eq(user.email, OWNER)).get()!.id;
});

beforeEach(() => {
  db.delete(rateLimit).run();
  db.update(user).set({ banned: false }).run();
  setAccess({ enabled: true, level: "drafts" });
  echoRun.mockClear();
  sentry.captureException.mockClear();
});

afterEach(() => {
  setClockForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Only the test tool is removed: the production tools stay registered.
  if (TOOLS.includes(echo)) TOOLS.splice(TOOLS.indexOf(echo), 1);
});

describe("obal nástrojů MCP", () => {
  test("[MCP-012] povolený nástroj vrátí text i strukturovaný výstup a zapíše použití", async () => {
    const { claims, clientId } = await connect();
    const result = await runTool(echo, claims, { text: "ahoj" }, env);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "ahoj" }]);
    expect(result.structuredContent).toEqual({ text: "ahoj", ownerId });
    const consent = db
      .select({ lastUsedAt: oauthConsent.lastUsedAt })
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, ownerId), eq(oauthConsent.clientId, clientId)))
      .get();
    expect(consent?.lastUsedAt).toBeInstanceOf(Date);
  });

  test("[MCP-012] vypnutý hlavní vypínač", async () => {
    const { claims } = await connect();
    setAccess({ enabled: false });
    const result = await runTool(echo, claims, { text: "ahoj" }, env);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: T.disabled }] });
    expect(echoRun).not.toHaveBeenCalled();
  });

  test("[MCP-012] vypnutá schopnost vrací českou větu „… je v Nastavení › Asistenti vypnuté.“ a isError", async () => {
    const { claims } = await connect();
    setAccess({ level: "read" });
    // The capability is checked before the input: a wrong input says the same.
    for (const raw of [{ text: "Alfa s.r.o." }, { nic: 1 }]) {
      const result = await runTool(createCustomer, claims, raw, env);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Zakládání faktur je v Nastavení › Asistenti vypnuté.");
    }
    expect(db.select().from(customer).all()).toHaveLength(0);
  });

  test("[MCP-013] odpojený klient s platným tokenem", async () => {
    serveJwksFrom(auth);
    TOOLS.push(echo);
    const { accessToken, clientId } = await connect();
    const call = async () => {
      const response = await mcpEndpoint(
        auth,
        env,
        new Request(RESOURCE, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "echo", arguments: { text: "ahoj" } },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      const json = body.startsWith("{") ? body : /^data: (.*)$/m.exec(body)![1]!;
      return (JSON.parse(json) as { result: { isError?: boolean; content: unknown } }).result;
    };

    expect(textOf(await call())).toBe("ahoj");
    disconnectMcpClient({ userId: ownerId, source: "web" }, clientId);
    // The token itself has not expired: the endpoint accepts it, the wrapper refuses the call.
    expect(decodeJwt(accessToken).exp! * 1000).toBeGreaterThan(Date.now());
    const after = await call();
    expect(after.isError).toBe(true);
    expect(textOf(after)).toBe(T.notConnected);
    expect(echoRun).toHaveBeenCalledTimes(1);
  });

  test("[MCP-012] zablokovaný uživatel", async () => {
    const { claims } = await connect();
    db.update(user).set({ banned: true }).where(eq(user.id, ownerId)).run();
    const result = await runTool(echo, claims, { text: "ahoj" }, env);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: T.noAccount }] });

    const unknown = await runTool(echo, { ...claims, sub: "neexistuje" }, { text: "ahoj" }, env);
    expect(textOf(unknown)).toBe(T.noAccount);
    expect(echoRun).not.toHaveBeenCalled();
  });

  test("[MCP-012] mimo dostupnost MCP nástroj neběží", async () => {
    const { claims } = await connect();
    const result = await runTool(echo, claims, { text: "ahoj" }, testEnv({ MCP_ENABLED: "0" }));
    expect(textOf(result)).toBe(T.unavailable);
    expect(echoRun).not.toHaveBeenCalled();
  });

  test("[MCP-030] zápisová akce má v auditu source mcp a client_name", async () => {
    const { claims, clientId } = await connect("Claude Desktop");
    const result = await runTool(createCustomer, claims, { text: "Alfa s.r.o." }, env);
    expect(result.isError).toBeFalsy();
    const id = (result.structuredContent as { id: string }).id;
    const row = db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "customer.save"), eq(auditLog.entityId, id)))
      .get();
    expect(row).toMatchObject({
      source: "mcp",
      actorId: ownerId,
      ownerId,
      clientId,
      clientName: "Claude Desktop",
    });
    expect(row?.requestId).toEqual(expect.any(String));
  });

  test("[MCP-012] chybný vstup, chyba služby a chyba nástroje vrátí českou větu", async () => {
    const { claims } = await connect();
    const invalid = await runTool(echo, claims, { text: "", navic: 1 }, env);
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toMatch(/^Neplatné vstupy: /);
    expect(textOf(invalid)).toContain("text");
    expect(echoRun).not.toHaveBeenCalled();

    const failing = (error: Error): ToolDef<{ text: string }, z.infer<typeof echoOutput>> =>
      defineTool({ ...echo, run: () => Promise.reject(error) });
    const service = await runTool(
      failing(new ServiceError("Zákazník neexistuje")),
      claims,
      {
        text: "x",
      },
      env,
    );
    expect(service).toEqual({
      isError: true,
      content: [{ type: "text", text: "Zákazník neexistuje" }],
    });
    const own = await runTool(
      failing(new McpToolError("Faktura nenalezena")),
      claims,
      {
        text: "x",
      },
      env,
    );
    expect(textOf(own)).toBe("Faktura nenalezena");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  test("[MCP-036] chyba nástroje nepošle do Sentry argumenty", async () => {
    vi.stubEnv("SENTRY_DSN", "https://k@errors.example.cz/1");
    const { claims } = await connect();
    const broken = defineTool({
      ...echo,
      run: () => {
        throw new Error("rozbité");
      },
    });
    const result = await runTool(broken, claims, { text: "tajný-argument" }, env);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: T.failed }] });

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = sentry.captureException.mock.calls[0]!;
    expect((error as Error).message).toBe("rozbité");
    expect(context).toEqual({ tags: { "mcp.tool": "echo" }, user: { id: ownerId } });
    expect(JSON.stringify(context)).not.toContain("tajný-argument");
  });
});
