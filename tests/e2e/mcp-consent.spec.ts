import { createHash, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";
const EMAIL = "majitel@example.cz";
// Nothing listens here: the test answers the client's callback itself.
const REDIRECT_URI = "http://127.0.0.1:33418/callback";
const CLIENT_NAME = "<b>Claude</b> Code";

async function registerClient(baseURL: string): Promise<string> {
  const response = await fetch(`${baseURL}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBeLessThan(300);
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizeUrl(baseURL: string, clientId: string, state: string): string {
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
async function answer(page: Page, button: "Povolit" | "Zamítnout"): Promise<URL> {
  const callback = page.waitForRequest((request) => request.url().startsWith(REDIRECT_URI));
  await page.getByRole("button", { name: button }).click();
  return new URL((await callback).url());
}

test("[MCP-005] souhlasová stránka", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await page.route(`${REDIRECT_URI}**`, (route) =>
    route.fulfill({ contentType: "text/plain", body: "ok" }),
  );
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByText(EMAIL)).toBeVisible();
  await page.context().clearCookies();
  const clientId = await registerClient(baseURL);

  // MCP-003: the login continues the authorization.
  await page.goto(authorizeUrl(baseURL, clientId, "zamitnuti"));
  await expect(page).toHaveURL(/\/prihlaseni\?/);
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(page).toHaveURL(/\/pristup-asistenta\?/);

  await expect(
    page.getByRole("heading", { name: `${CLIENT_NAME} chce přístup k vašemu Fakturanu` }),
  ).toBeVisible();
  await expect(page.locator("h1 b")).toHaveCount(0);
  await expect(page.getByText("aplikace na tomto počítači")).toBeVisible();
  await expect(page.getByText("Název uvádí aplikace sama.")).toBeVisible();
  await expect(page.getByText("Číst faktury, zákazníky, ceník a přehledy")).toBeVisible();
  await expect(page.getByRole("link", { name: "Nastavení › Asistenti" })).toHaveAttribute(
    "href",
    "/nastaveni/asistenti",
  );

  const denied = await answer(page, "Zamítnout");
  expect(denied.searchParams.get("error")).toBe("access_denied");
  expect(denied.searchParams.get("state")).toBe("zamitnuti");

  // Signed in now: authorization goes straight to consent.
  await page.goto(authorizeUrl(baseURL, clientId, "povoleni"));
  await expect(page).toHaveURL(/\/pristup-asistenta\?/);
  const granted = await answer(page, "Povolit");
  expect(granted.origin + granted.pathname).toBe(REDIRECT_URI);
  expect(granted.searchParams.get("code")).toEqual(expect.any(String));
  expect(granted.searchParams.get("state")).toBe("povoleni");
});
