import { expect, test } from "./fixtures";
import {
  answer,
  authorizeUrl,
  EMAIL,
  PASSWORD,
  REDIRECT_URI,
  registerClient,
  registerOwner,
} from "./mcp-helpers";

const CLIENT_NAME = "<b>Claude</b> Code";

test("[MCP-005][MCP-006] souhlasová stránka", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await page.route(`${REDIRECT_URI}**`, (route) =>
    route.fulfill({ contentType: "text/plain", body: "ok" }),
  );
  await registerOwner(page, baseURL);
  await page.context().clearCookies();
  const clientId = await registerClient(baseURL, CLIENT_NAME);

  // MCP-003: the login continues the authorization.
  await page.goto(authorizeUrl(baseURL, clientId, "zamitnuti"));
  await expect(page).toHaveURL(/\/prihlaseni\?/);
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(page).toHaveURL(/\/pristup-asistenta\?/);

  // MCP-006: access is off by default, so the authorization ends on the explanation.
  await expect(page.getByRole("heading", { name: "Přístup asistentů je vypnutý" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Povolit" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Otevřít Nastavení › Asistenti" })).toHaveAttribute(
    "href",
    "/nastaveni/asistenti",
  );

  // Switched on in Nastavení › Asistenti at Koncepty, reloading the same page shows the consent.
  const settings = await page.context().newPage();
  await settings.goto(`${baseURL}/nastaveni/asistenti`);
  await settings.waitForLoadState("networkidle");
  await settings.getByRole("checkbox", { name: "Povolit připojení asistentů" }).click();
  await expect(settings.getByText("Nastavení uloženo")).toBeVisible();
  await settings.getByRole("radio", { name: "Koncepty" }).check();
  await expect(settings.getByRole("radio", { name: "Koncepty" })).toBeChecked();
  await expect(settings.getByText("Nastavení uloženo")).toBeVisible();
  await settings.close();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: `${CLIENT_NAME} chce přístup k vašemu Fakturanu` }),
  ).toBeVisible();
  await expect(page.locator("h1 b")).toHaveCount(0);
  await expect(page.getByText("aplikace na tomto počítači")).toBeVisible();
  await expect(page.getByText("Název uvádí aplikace sama.")).toBeVisible();
  // [MCP-054] The consent shows the current level instead of a list of capabilities.
  await expect(page.getByText("Úroveň oprávnění: Koncepty")).toBeVisible();
  await expect(page.getByText(/Zakládat a upravovat koncepty faktur/)).toBeVisible();
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
