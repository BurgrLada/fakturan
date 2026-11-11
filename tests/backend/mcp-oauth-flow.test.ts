import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { SOCIAL_REJECTED_PATH } from "@/server/auth/audit-hooks";
import { instanceMeta, rateLimit, user } from "@/server/db/schema";
import { parseEnv, type Env } from "@/server/env";
import { consentRequest } from "@/server/mcp/consent-info";
import { Browser, fakeGithub, type Auth } from "../helpers/auth-browser";
import { createTestDb } from "../helpers/db";

const db = createTestDb();

const BASE = "http://localhost:3000";
const ISSUER = `${BASE}/api/auth`;
const RESOURCE = `${BASE}/api/mcp`;
const REDIRECT_URI = "http://127.0.0.1:33418/callback";
const OWNER = "majitel@example.cz";
const dataDir = mkdtempSync(join(tmpdir(), "fakturan-mcp-flow-"));

function testEnv(extra: Record<string, string> = {}): Env {
  return parseEnv({
    DATA_DIR: dataDir,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ...extra,
  });
}

// The steps of an assistant connecting through OAuth. Kept free of test state so they can move to
// tests/helpers/mcp-oauth.ts (Task 5).

async function registerClient(auth: Auth, redirectUri = REDIRECT_URI): Promise<string> {
  const response = await auth.handler(
    new Request(`${ISSUER}/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(response.status).toBeLessThan(300);
  return ((await response.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type Authorization = { clientId: string; verifier: string; redirectUri: string };

// Starts /oauth2/authorize and returns where the provider sent the browser.
async function authorize(browser: Browser, clientId: string, redirectUri = REDIRECT_URI) {
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "fakturan offline_access",
    state: "stav-1",
    resource: RESOURCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const response = await browser.request(`/oauth2/authorize?${query}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!, BASE);
  return { location, flow: { clientId, verifier, redirectUri } satisfies Authorization };
}

// What the login form sends: the signed query of the page it is on.
function oauthQuery(page: URL): string {
  return page.search.slice(1);
}

async function signInDuringAuthorization(browser: Browser, loginPage: URL, email: string) {
  const response = await browser.request("/sign-in/email", {
    body: { email, password: "správné-kůň-baterie-sponka", oauth_query: oauthQuery(loginPage) },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { redirect?: boolean; url?: string };
  return body.redirect && body.url ? new URL(body.url, BASE) : null;
}

// A social login as the browser runs it: the button posts with the signed query, the provider
// sends the browser back to the callback, which is a navigation.
async function githubDuringAuthorization(browser: Browser, loginPage: URL) {
  const start = await browser.request("/sign-in/social", {
    body: {
      provider: "github",
      callbackURL: "/",
      errorCallbackURL: "/prihlaseni",
      oauth_query: oauthQuery(loginPage),
    },
  });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const callback = await browser.request(
    `/callback/github?code=kod&state=${encodeURIComponent(state)}`,
    { headers: { "sec-fetch-mode": "navigate", accept: "text/html" } },
  );
  expect(callback.status).toBe(302);
  return new URL(callback.headers.get("location")!, BASE);
}

async function answerConsent(browser: Browser, consentPage: URL, accept: boolean) {
  const response = await browser.request("/oauth2/consent", {
    body: { accept, oauth_query: oauthQuery(consentPage) },
  });
  expect(response.status).toBe(200);
  return new URL(((await response.json()) as { url: string }).url);
}

async function tokenRequest(auth: Auth, params: Record<string, string>) {
  const response = await auth.handler(
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: RESOURCE }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

function exchangeCode(auth: Auth, flow: Authorization, code: string) {
  return tokenRequest(auth, {
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
  });
}

function refresh(auth: Auth, clientId: string, refreshToken: string) {
  return tokenRequest(auth, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

function userCount(): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(user)
      .get()?.n ?? 0
  );
}

const env = testEnv();
const auth = createAuth(env);

beforeEach(async () => {
  db.delete(rateLimit).run();
  db.delete(user).run();
  db.delete(instanceMeta).run();
  // The first account on an empty instance needs no invitation.
  await new Browser(auth).signUp(OWNER);
  db.update(user).set({ emailVerified: true }).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("přihlášení a souhlas v toku OAuth", () => {
  test("[MCP-002][MCP-003][MCP-007] tok s PKCE: přihlášení heslem, souhlas, token a jeho obnova", async () => {
    const browser = new Browser(auth);
    const clientId = await registerClient(auth);

    const { location: loginPage, flow } = await authorize(browser, clientId);
    expect(loginPage.pathname).toBe("/prihlaseni");
    expect(loginPage.searchParams.get("client_id")).toBe(clientId);

    const consentPage = await signInDuringAuthorization(browser, loginPage, OWNER);
    expect(consentPage?.pathname).toBe("/pristup-asistenta");

    // What the consent page reads from its own query.
    expect(await consentRequest(db, env, oauthQuery(consentPage!))).toMatchObject({
      clientId,
      name: "Claude Code",
      host: "aplikace na tomto počítači",
      nameIsClaimed: true,
      oauthQuery: oauthQuery(consentPage!),
    });

    const callback = await answerConsent(browser, consentPage!, true);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("stav-1");
    const code = callback.searchParams.get("code")!;
    expect(code).toEqual(expect.any(String));

    const tokens = await exchangeCode(auth, flow, code);
    const claims = decodeJwt(tokens.access_token);
    expect([claims.aud].flat()).toContain(RESOURCE);
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(900);
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const renewed = await refresh(auth, clientId, tokens.refresh_token!);
    expect(renewed.refresh_token).toEqual(expect.any(String));
    expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
    expect([decodeJwt(renewed.access_token).aud].flat()).toContain(RESOURCE);
  });

  test("[MCP-003] sociální přihlášení během autorizace pokračuje na souhlas", async () => {
    const browser = new Browser(auth);
    const clientId = await registerClient(auth);
    const { location: loginPage } = await authorize(browser, clientId);
    fakeGithub(OWNER);

    const next = await githubDuringAuthorization(browser, loginPage);

    expect(next.pathname).toBe("/pristup-asistenta");
    expect(next.searchParams.get("client_id")).toBe(clientId);
    expect(await browser.sessionUser()).toMatchObject({ email: OWNER });
  });

  test("[MCP-005] zamítnutí vrátí klientovi access_denied", async () => {
    const browser = new Browser(auth);
    const clientId = await registerClient(auth);
    const { location: loginPage } = await authorize(browser, clientId);
    const consentPage = await signInDuringAuthorization(browser, loginPage, OWNER);

    const callback = await answerConsent(browser, consentPage!, false);

    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  test("[MCP-005] souhlasová stránka nepřijme podvržený ani cizí dotaz", async () => {
    const browser = new Browser(auth);
    const clientId = await registerClient(auth);
    const otherClient = await registerClient(auth, "https://zly.example/cb");
    const { location: loginPage } = await authorize(browser, clientId);
    const consentPage = await signInDuringAuthorization(browser, loginPage, OWNER);
    const forged = new URLSearchParams(oauthQuery(consentPage!));
    forged.set("client_id", otherClient);

    expect(await consentRequest(db, env, forged.toString())).toBeNull();
    expect(await consentRequest(db, env, "client_id=" + clientId)).toBeNull();
  });

  test("[MCP-004] cizí e-mail: sociální přihlášení během autorizace nezaloží účet", async () => {
    const browser = new Browser(auth);
    const clientId = await registerClient(auth);
    const { location: loginPage } = await authorize(browser, clientId);
    const before = userCount();
    fakeGithub("cizi@example.cz");

    const next = await githubDuringAuthorization(browser, loginPage);

    expect(next.href).toBe(new URL(SOCIAL_REJECTED_PATH, BASE).href);
    expect(userCount()).toBe(before);
    expect(await browser.sessionUser()).toBeNull();
  });

  test.todo("[MCP-006] vypnutý přístup asistentů skončí vysvětlením, souhlas ani token nevydá");
});
