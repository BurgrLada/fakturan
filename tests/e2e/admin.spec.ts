import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";

async function register(page: Page, name: string, email: string) {
  await page.getByLabel("Jméno").fill(name);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
}

async function createAdmin(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await register(page, "Správce", "admin@example.cz");
  await expect(page.getByText("admin@example.cz")).toBeVisible();
  await page.goto(`${baseURL}/administrace`);
  await expect(page.getByRole("heading", { name: "Administrace" })).toBeVisible();
}

async function invite(page: Page, email: string): Promise<string> {
  await page.getByRole("tab", { name: "Pozvánky" }).click();
  await page.getByLabel("E-mail pozvaného").fill(email);
  await page.getByRole("button", { name: "Pozvat" }).click();
  const link = page.getByLabel("Odkaz pozvánky");
  await expect(link).toBeVisible();
  return link.inputValue();
}

async function invitedUser(browser: Browser, url: string, name: string, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Pokračovat k registraci" }).click();
  await expect(page).toHaveURL(/\/registrace$/);
  await expect(page.getByLabel("E-mail")).toHaveValue(email);
  await page.getByLabel("Jméno").fill(name);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  return page;
}

test("[ADM-003] pozvání uživatele, přijetí, oddělené účty", async ({ page, browser, freshApp }) => {
  await createAdmin(page, freshApp.baseURL);
  const url = await invite(page, "host@example.cz");
  expect(url).toContain("/pozvanka/");

  const guest = await invitedUser(browser, url, "Host", "host@example.cz");

  await page.reload();
  const row = page.getByRole("row", { name: /host@example\.cz/ });
  await expect(row.getByText("Uživatel")).toBeVisible();
  await expect(row.getByText("Aktivní")).toBeVisible();

  const denied = await guest.goto(`${freshApp.baseURL}/administrace`);
  expect(denied?.status()).toBe(404);

  await page.reload();
  await page.getByRole("tab", { name: "Události instance" }).click();
  await expect(page.getByText("Odmítnutý přístup")).toBeVisible();

  await guest.goto(url);
  await expect(guest.getByText("Tato pozvánka už byla použita")).toBeVisible();
});

test("[ADM-005] deaktivace odhlásí otevřenou záložku a zablokuje přihlášení", async ({
  page,
  browser,
  freshApp,
}) => {
  await createAdmin(page, freshApp.baseURL);
  const url = await invite(page, "host@example.cz");
  const guest = await invitedUser(browser, url, "Host", "host@example.cz");
  await guest.goto(`${freshApp.baseURL}/nastaveni/ucet`);
  await expect(guest.getByRole("heading", { name: "Účet" })).toBeVisible();

  await page.reload();
  const row = page.getByRole("row", { name: /host@example\.cz/ });
  await row.getByRole("button", { name: "Deaktivovat" }).click();
  await expect(row.getByText("Deaktivovaný")).toBeVisible();

  await guest.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(guest).toHaveURL(/\/prihlaseni$/);

  await guest.getByLabel("E-mail").fill("host@example.cz");
  await guest.getByLabel("Heslo", { exact: true }).fill(PASSWORD);
  await guest.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(guest.getByText("Tento účet je deaktivovaný.")).toBeVisible();
});

test("[ADM-006] smazání ukáže upozornění a vyžaduje opsání e-mailu", async ({
  page,
  browser,
  freshApp,
}) => {
  await createAdmin(page, freshApp.baseURL);
  const url = await invite(page, "host@example.cz");
  await invitedUser(browser, url, "Host", "host@example.cz");

  await page.reload();
  await page
    .getByRole("row", { name: /host@example\.cz/ })
    .getByRole("button", { name: "Smazat" })
    .click();
  await expect(page.getByText("Export si musí udělat sám uživatel")).toBeVisible();
  const confirm = page.getByRole("button", { name: "Smazat natrvalo" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Pro potvrzení opište e-mail").fill("host@example.cz");
  await confirm.click();

  await expect(page.getByRole("row", { name: /host@example\.cz/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "Události instance" }).click();
  await expect(page.getByText("Smazání účtu")).toBeVisible();
});

test("[ADM-009] uživatel smaže vlastní účet po zadání hesla", async ({
  page,
  browser,
  freshApp,
}) => {
  await createAdmin(page, freshApp.baseURL);
  const url = await invite(page, "host@example.cz");
  const guest = await invitedUser(browser, url, "Host", "host@example.cz");

  await guest.goto(`${freshApp.baseURL}/nastaveni/ucet`);
  await guest.getByLabel("Heslo", { exact: true }).fill("spatne-heslo-spatne");
  await guest.getByRole("button", { name: "Smazat můj účet" }).click();
  await expect(guest.getByText("Nesprávné heslo")).toBeVisible();

  await guest.getByLabel("Heslo", { exact: true }).fill(PASSWORD);
  await guest.getByRole("button", { name: "Smazat můj účet" }).click();
  await expect(guest).toHaveURL(/\/prihlaseni$/);
});

test("[ADM-006] chyba smazání se ukáže přímo v dialogu", async ({ page, browser, freshApp }) => {
  await createAdmin(page, freshApp.baseURL);
  const url = await invite(page, "host@example.cz");
  await invitedUser(browser, url, "Host", "host@example.cz");
  await page.reload();
  await page
    .getByRole("row", { name: /host@example\.cz/ })
    .getByRole("button", { name: "Smazat" })
    .click();
  await page.getByLabel("Pro potvrzení opište e-mail").fill("host@example.cz");

  const other = await page.context().newPage();
  await other.goto(`${freshApp.baseURL}/administrace`);
  await other
    .getByRole("row", { name: /host@example\.cz/ })
    .getByRole("button", { name: "Smazat" })
    .click();
  await other.getByLabel("Pro potvrzení opište e-mail").fill("host@example.cz");
  await other.getByRole("button", { name: "Smazat natrvalo" }).click();
  await expect(other.getByRole("row", { name: /host@example\.cz/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Smazat natrvalo" }).click();
  await expect(page.getByRole("alertdialog").getByText("Uživatel neexistuje")).toBeVisible();
});
