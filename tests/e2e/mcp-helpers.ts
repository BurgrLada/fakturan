import { createHash, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export const PASSWORD = "správné-kůň-baterie-sponka";
export const EMAIL = "majitel@example.cz";
// Nothing listens here: the test answers the client's callback itself.
export const REDIRECT_URI = "http://127.0.0.1:33418/callback";

export async function registerOwner(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByText(EMAIL)).toBeVisible();
}

export async function registerClient(baseURL: string, name: string): Promise<string> {
  const response = await fetch(`${baseURL}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBeLessThan(300);
  return ((await response.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(baseURL: string, clientId: string, state: string): string {
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  return `${baseURL}/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "fakturan offline_access",
    state,
    resource: `${baseURL}/api/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
}

// Clicks a consent button and returns the callback URL the browser was sent to.
export async function answer(page: Page, button: "Povolit" | "Zamítnout"): Promise<URL> {
  const callback = page.waitForRequest((request) => request.url().startsWith(REDIRECT_URI));
  await page.getByRole("button", { name: button }).click();
  return new URL((await callback).url());
}
