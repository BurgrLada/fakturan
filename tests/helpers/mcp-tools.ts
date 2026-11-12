import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { desc, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { vi } from "vitest";
import type { McpLevel } from "@/lib/mcp-settings";
import { createAuth } from "@/server/auth";
import type { Db } from "@/server/db";
import { auditLog, rateLimit, user } from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { runTool, TOOLS, type McpClaims } from "@/server/mcp/tool";
// Registers every production tool in TOOLS.
import "@/server/mcp/server";
import { createInvitation } from "@/server/services/invitations";
import { getMcpSettings, saveMcpSettings } from "@/server/services/mcp-settings";
import { BASE, Browser } from "./auth-browser";
import { issueMcpToken } from "./mcp-oauth";

let shared: {
  values: Record<string, string>;
  env: Env;
  auth: ReturnType<typeof createAuth>;
} | null = null;

// One instance per test file: the env and the auth server the tool tests call through.
export function mcpInstance() {
  shared ??= (() => {
    const values = {
      DATA_DIR: mkdtempSync(join(tmpdir(), "fakturan-mcp-tools-")),
      BETTER_AUTH_URL: BASE,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    const env = parseEnv(values);
    return { values, env, auth: createAuth(env) };
  })();
  return shared;
}

// A fresh user with the assistant access on at the given level and one connected client.
export async function mcpAccount(
  db: Db,
  opts: { level?: McpLevel; logCalls?: boolean } = {},
): Promise<{ ownerId: string; claims: McpClaims }> {
  const { auth, values } = mcpInstance();
  const email = `asistent-${randomUUID()}@example.cz`;
  const browser = new Browser(auth);
  // The first user of the instance signs up freely; every next one needs an invitation (admin).
  const admin = db.select({ id: user.id }).from(user).where(eq(user.role, "admin")).get();
  if (admin) {
    // Many accounts per file: the invitation limit protects people, not the tests.
    db.delete(rateLimit).run();
    // The invitation service reads the process env; a test file may have unstubbed it.
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    const { url } = await createInvitation({ userId: admin.id, source: "web" }, email);
    browser.cookies.set("fakturan_invite", url.split("/").at(-1)!);
  }
  const signedUp = await browser.signUp(email);
  if (!signedUp.ok) {
    throw new Error(`Registrace selhala: ${signedUp.status} ${await signedUp.text()}`);
  }
  const ownerId = db.select({ id: user.id }).from(user).where(eq(user.email, email)).get()!.id;
  saveMcpSettings(
    { userId: ownerId, source: "web" },
    {
      ...getMcpSettings(ownerId),
      enabled: true,
      level: opts.level ?? "read",
      logCalls: opts.logCalls ?? true,
    },
  );
  const token = await issueMcpToken(auth, browser, "Claude Code");
  return { ownerId, claims: decodeJwt(token.accessToken) as McpClaims };
}

// Calls a registered tool by name through the wrapper, with every check of MCP-052.
export function callTool(name: string, claims: McpClaims, args: unknown): Promise<CallToolResult> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (!def) throw new Error(`Nástroj ${name} není registrovaný`);
  return runTool(def, claims, args, mcpInstance().env);
}

// The source of the user's newest audit row, to check a mutation came through the assistant.
export function lastAuditSource(db: Db, ownerId: string): string | null {
  const row = db
    .select({ source: auditLog.source })
    .from(auditLog)
    .where(eq(auditLog.ownerId, ownerId))
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  return row?.source ?? null;
}
