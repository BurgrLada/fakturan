import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createAuth } from "@/server/auth";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  rateLimit,
  user,
} from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { isMcpAvailable, MCP_SCOPE, mcpResource } from "@/server/mcp/availability";
import { oauthMetadata } from "@/server/mcp/well-known";
import { Browser } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";

const db = createTestDb();

const BASE = "http://localhost:3000";
const ISSUER = `${BASE}/api/auth`;
const RESOURCE = `${BASE}/api/mcp`;
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-mcp-auth-"));

const SECRETS = {
  DATA_DIR: dataDir,
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function testEnv(extra: Record<string, string> = {}): Env {
  return parseEnv({ ...SECRETS, ...extra });
}

const DEMO = {
  DEMO_MODE: "1",
  DEMO_EMAIL: "ukazka@fakturan.example",
  DEMO_PASSWORD: "ukazka-heslo",
};

type Auth = ReturnType<typeof createAuth>;

function get(auth: Auth, path: string): Promise<Response> {
  return auth.handler(new Request(BASE + path));
}

function register(auth: Auth, body: Record<string, unknown> = {}): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: ["http://127.0.0.1:33418/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...body,
      }),
    }),
  );
}

function wellKnown(path: string): Request {
  return new Request(BASE + path);
}

beforeEach(() => {
  db.delete(rateLimit).run();
});

describe("dostupnost MCP", () => {
  test("[MCP-038] MCP je dostupné mimo demo, dokud ho MCP_ENABLED nevypne", () => {
    expect(isMcpAvailable(testEnv())).toBe(true);
    expect(isMcpAvailable(testEnv({ MCP_ENABLED: "false" }))).toBe(false);
    expect(isMcpAvailable(testEnv(DEMO))).toBe(false);
  });

  test("[MCP-045] zdroj MCP se odvozuje z BETTER_AUTH_URL bez koncového lomítka", () => {
    expect(mcpResource(testEnv())).toBe(RESOURCE);
    expect(mcpResource(testEnv({ BETTER_AUTH_URL: "https://faktury.example.cz/" }))).toBe(
      "https://faktury.example.cz/api/mcp",
    );
    expect(MCP_SCOPE).toBe("fakturan");
  });
});

describe("autorizační server MCP", () => {
  test("[MCP-001] publikuje metadata autorizačního serveru", async () => {
    const env = testEnv();
    const auth = createAuth(env);
    for (const response of [
      await oauthMetadata(auth, env, wellKnown("/.well-known/oauth-authorization-server/api/auth")),
      await get(auth, "/api/auth/.well-known/oauth-authorization-server"),
    ]) {
      expect(response.status).toBe(200);
      const metadata = await response.json();
      expect(metadata.issuer).toBe(ISSUER);
      expect(metadata.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
      expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
      expect(metadata.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
      expect(metadata.code_challenge_methods_supported).toContain("S256");
      expect(metadata.scopes_supported).toEqual(["fakturan", "offline_access"]);
      expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
    }
  });

  test("[MCP-001] publikuje metadata chráněného zdroje", async () => {
    const env = testEnv();
    const auth = createAuth(env);
    const response = await oauthMetadata(
      auth,
      env,
      wellKnown("/.well-known/oauth-protected-resource/api/mcp"),
    );
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata.resource).toBe(RESOURCE);
    expect(metadata.authorization_servers).toEqual([ISSUER]);
    expect(metadata.scopes_supported).toEqual(["fakturan"]);
    expect(metadata.bearer_methods_supported).toEqual(["header"]);
  });

  test("[MCP-001] cizí cesta pod .well-known vrátí 404", async () => {
    const env = testEnv();
    const auth = createAuth(env);
    const other = await oauthMetadata(
      auth,
      env,
      wellKnown("/.well-known/oauth-authorization-server/jinde"),
    );
    expect(other.status).toBe(404);
    const resource = await oauthMetadata(
      auth,
      env,
      wellKnown("/.well-known/oauth-protected-resource/api/jinde"),
    );
    expect(resource.status).toBe(404);
  });

  test("[MCP-001] trasy Next v kořeni domény metadata najdou", async () => {
    for (const [key, value] of Object.entries(SECRETS)) vi.stubEnv(key, value);
    try {
      const server =
        await import("@/app/.well-known/oauth-authorization-server/[[...issuer]]/route");
      const resource = await import("@/app/.well-known/oauth-protected-resource/[[...path]]/route");
      const asResponse = await server.GET(
        wellKnown("/.well-known/oauth-authorization-server/api/auth"),
      );
      expect((await asResponse.json()).issuer).toBe(ISSUER);
      const prResponse = await resource.GET(
        wellKnown("/.well-known/oauth-protected-resource/api/mcp"),
      );
      expect((await prResponse.json()).resource).toBe(RESOURCE);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("[MCP-002] dynamická registrace veřejného klienta s PKCE", async () => {
    const auth = createAuth(testEnv());
    const response = await register(auth);
    expect(response.status).toBeLessThan(300);
    const client = await response.json();
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.scope.split(" ")).toContain("fakturan");

    const row = db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, client.client_id))
      .get();
    expect(row?.requirePKCE).not.toBe(false);
  });

  test("[MCP-002] dynamická registrace webového klienta s HTTPS callbackem", async () => {
    const auth = createAuth(testEnv());
    const response = await register(auth, {
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    expect(response.status).toBeLessThan(300);
    const client = await response.json();
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  test("[MCP-002] registrace s jiným rozsahem než fakturan je odmítnuta", async () => {
    const auth = createAuth(testEnv());
    const response = await register(auth, { scope: "openid email" });
    expect(response.status).toBe(400);
  });

  test("[MCP-032] registrace klientů má limit 10 za hodinu podle IP", async () => {
    const auth = createAuth(testEnv());
    for (let i = 0; i < 10; i++) expect((await register(auth)).status).toBeLessThan(300);
    const denied = await register(auth);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toEqual(expect.any(String));
  });

  test.each([
    ["[MCP-009] demo režim", DEMO],
    ["[MCP-038] MCP_ENABLED=false", { MCP_ENABLED: "false" }],
  ])("%s: metadata i registrace vrací 404", async (_, extra) => {
    const env = testEnv(extra);
    const auth = createAuth(env);
    const responses = [
      await oauthMetadata(auth, env, wellKnown("/.well-known/oauth-authorization-server/api/auth")),
      await oauthMetadata(auth, env, wellKnown("/.well-known/oauth-protected-resource/api/mcp")),
      await get(auth, "/api/auth/.well-known/oauth-authorization-server"),
      await get(auth, "/api/auth/jwks"),
      await get(auth, "/api/auth/oauth2/authorize?client_id=x&response_type=code"),
      await register(auth),
    ];
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  test("[MCP-007] autorizace s PKCE vydá JWT s audience /api/mcp na 15 minut a obnovovací token, relace JWT nevydá", async () => {
    const auth = createAuth(testEnv());
    const browser = new Browser(auth);
    await browser.signUp("majitel@example.cz");
    // The session itself carries no JWT signed with the keys a resource server trusts.
    const session = await browser.request("/get-session");
    expect((await session.json())?.user?.email).toBe("majitel@example.cz");
    expect(session.headers.get("set-auth-jwt")).toBeNull();
    const redirectUri = "http://127.0.0.1:33418/callback";
    const { client_id: clientId } = await (await register(auth)).json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeQuery = (pkce: boolean) =>
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "fakturan offline_access",
        state: "s1",
        resource: RESOURCE,
        ...(pkce ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
      });

    const withoutPkce = await browser.request(`/oauth2/authorize?${authorizeQuery(false)}`);
    expect(withoutPkce.headers.get("location") ?? "").toMatch(/error=invalid_request/);

    const authorize = await browser.request(`/oauth2/authorize?${authorizeQuery(true)}`);
    const consentUrl = new URL(authorize.headers.get("location")!, BASE);
    expect(consentUrl.pathname).toBe("/pristup-asistenta");
    const consent = await browser.request("/oauth2/consent", {
      body: { accept: true, oauth_query: consentUrl.search.slice(1) },
    });
    const callback = new URL((await consent.json()).url);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    const code = callback.searchParams.get("code")!;

    const token = await auth.handler(
      new Request(`${ISSUER}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      }),
    );
    expect(token.status).toBe(200);
    const body = await token.json();
    expect(body.refresh_token).toEqual(expect.any(String));
    expect(body.expires_in).toBe(900);
    const claims = decodeJwt(body.access_token);
    expect(claims).toMatchObject({ iss: ISSUER, aud: RESOURCE, azp: clientId });
    expect(String(claims.scope).split(" ")).toContain("fakturan");
    expect(claims.sub).toEqual(expect.any(String));
  });

  test("[MCP-042] smazání uživatele smaže jeho tokeny a souhlasy, klient zůstane", async () => {
    const auth = createAuth(testEnv());
    const { client_id: clientId } = await (await register(auth)).json();
    const now = new Date();
    db.insert(user)
      .values({ id: "u1", name: "U", email: "u1@example.cz", createdAt: now, updatedAt: now })
      .run();
    db.update(oauthClient).set({ userId: "u1" }).where(eq(oauthClient.clientId, clientId)).run();
    db.insert(oauthConsent)
      .values({
        id: "c1",
        clientId,
        userId: "u1",
        scopes: '["fakturan"]',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(oauthRefreshToken)
      .values({
        id: "r1",
        token: "hash-r1",
        clientId,
        userId: "u1",
        scopes: '["fakturan"]',
        expiresAt: now,
        createdAt: now,
      })
      .run();
    db.insert(oauthAccessToken)
      .values({
        id: "a1",
        token: "hash-a1",
        clientId,
        userId: "u1",
        refreshId: "r1",
        scopes: '["fakturan"]',
        expiresAt: now,
        createdAt: now,
      })
      .run();

    db.delete(user).where(eq(user.id, "u1")).run();

    for (const table of [oauthConsent, oauthRefreshToken, oauthAccessToken]) {
      expect(db.select().from(table).where(eq(table.clientId, clientId)).all()).toEqual([]);
    }
    const client = db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).get();
    expect(client?.userId).toBeNull();
  });
});
