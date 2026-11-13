import { createHash, randomBytes } from "node:crypto";
import { expect, vi } from "vitest";
import { BASE, PASSWORD, type Auth, type Browser } from "./auth-browser";

// The steps of an assistant connecting through OAuth, against the auth handler of a test instance
// on BASE. Free of test state, shared by the OAuth flow and MCP endpoint tests.

export const ISSUER = `${BASE}/api/auth`;
export const RESOURCE = `${BASE}/api/mcp`;
export const REDIRECT_URI = "http://127.0.0.1:33418/callback";

export async function registerClient(
  auth: Auth,
  redirectUri = REDIRECT_URI,
  clientName = "Claude Code",
): Promise<string> {
  const response = await auth.handler(
    new Request(`${ISSUER}/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
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

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export type Authorization = { clientId: string; verifier: string; redirectUri: string };

// Starts /oauth2/authorize and returns where the provider sent the browser.
export async function authorize(browser: Browser, clientId: string, redirectUri = REDIRECT_URI) {
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
export function oauthQuery(page: URL): string {
  return page.search.slice(1);
}

export async function signInDuringAuthorization(browser: Browser, loginPage: URL, email: string) {
  const response = await browser.request("/sign-in/email", {
    body: { email, password: PASSWORD, oauth_query: oauthQuery(loginPage) },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { redirect?: boolean; url?: string };
  return body.redirect && body.url ? new URL(body.url, BASE) : null;
}

// A social login as the browser runs it: the button posts with the signed query, the provider
// sends the browser back to the callback, which is a navigation.
export async function githubDuringAuthorization(browser: Browser, loginPage: URL) {
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

export async function answerConsent(browser: Browser, consentPage: URL, accept: boolean) {
  const response = await browser.request("/oauth2/consent", {
    body: { accept, oauth_query: oauthQuery(consentPage) },
  });
  expect(response.status).toBe(200);
  return new URL(((await response.json()) as { url: string }).url);
}

export function tokenResponse(auth: Auth, params: Record<string, string>) {
  return auth.handler(
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: RESOURCE }),
    }),
  );
}

export type Tokens = { access_token: string; refresh_token?: string; expires_in: number };

export async function tokenRequest(auth: Auth, params: Record<string, string>): Promise<Tokens> {
  const response = await tokenResponse(auth, params);
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

export function codeParams(flow: Authorization, code: string) {
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
  };
}

export function exchangeCode(auth: Auth, flow: Authorization, code: string) {
  return tokenRequest(auth, codeParams(flow, code));
}

export function refresh(auth: Auth, clientId: string, refreshToken: string) {
  return tokenRequest(auth, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

// A new client connected by an already signed-in browser whose assistant access is on: register,
// authorize, consent, exchange the code. The token is real, signed by the instance's keys.
export async function issueMcpToken(
  auth: Auth,
  browser: Browser,
  clientName = "Claude Code",
): Promise<{ accessToken: string; refreshToken?: string; clientId: string }> {
  const clientId = await registerClient(auth, REDIRECT_URI, clientName);
  const { location, flow } = await authorize(browser, clientId);
  expect(location.pathname, "prohlížeč musí být přihlášený a přístup zapnutý").toBe(
    "/pristup-asistenta",
  );
  const callback = await answerConsent(browser, location, true);
  const code = callback.searchParams.get("code");
  expect(code).toEqual(expect.any(String));
  const tokens = await exchangeCode(auth, flow, code!);
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId };
}

// The endpoint verifies tokens against the instance's JWKS over HTTP (requireMcpAuth); in tests
// that address is served by the auth handler itself.
export function serveJwksFrom(auth: Auth): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith(`${ISSUER}/`)) return auth.handler(request);
      throw new Error(`Neočekávaný požadavek ${request.url}`);
    }),
  );
}
