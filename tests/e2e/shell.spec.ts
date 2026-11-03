import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";

async function registerAdmin(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Správce");
  await page.getByLabel("E-mail").fill("admin@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

test("[UI-009] nepřihlášený je z přehledu poslán na přihlášení", async ({ page, freshApp }) => {
  await page.goto(freshApp.baseURL);
  await expect(page).toHaveURL(/\/prihlaseni$/);
});

test("[UI-009] přehled bez dat ukazuje prázdné widgety s další akcí", async ({
  page,
  freshApp,
}) => {
  await registerAdmin(page, freshApp.baseURL);
  const card = page.getByRole("region", { name: "Fakturováno letos", exact: true });
  await expect(card.getByTestId("widget-empty")).toBeVisible();
  await card.getByRole("link", { name: "Nová faktura" }).click();
  await expect(page).toHaveURL(/\/faktury\//);
});

test("logo v hlavičce je odkaz na Přehled", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await registerAdmin(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Fakturan, přejít na Přehled" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByRole("heading", { name: "Přehled", level: 1 })).toBeVisible();
});

test("[UI-009] Statistiky už nejsou Připravujeme a neznámá adresa vrátí 404", async ({
  page,
  freshApp,
}) => {
  await registerAdmin(page, freshApp.baseURL);
  const nav = page.getByRole("navigation", { name: "Hlavní navigace" });
  await nav.getByRole("link", { name: "Platby" }).click();
  await expect(page.getByRole("heading", { name: "Platby", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Připravujeme" })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Hlavní navigace" })
    .getByRole("link", { name: "Statistiky" })
    .click();
  await expect(page.getByRole("heading", { name: "Statistiky", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Nová faktura" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Připravujeme" })).toHaveCount(0);
  const missing = await page.goto(`${freshApp.baseURL}/neexistuje`);
  expect(missing?.status()).toBe(404);
});

test("[UI-005] [SET-035] přepínač motivu a volba podle systému přetrvá", async ({
  page,
  freshApp,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await registerAdmin(page, freshApp.baseURL);
  expect(await isDark(page)).toBe(false);

  await page.getByRole("button", { name: "Tmavý" }).click();
  expect(await isDark(page)).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await isDark(page)).toBe(true);
  await expect(page.getByRole("button", { name: "Tmavý" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Světlý" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await isDark(page)).toBe(false);

  await page.getByRole("button", { name: "Podle systému" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => isDark(page)).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await isDark(page)).toBe(true);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => isDark(page)).toBe(false);
});

test("[SET-035] volba motivu se uloží v účtu a platí v jiném prohlížeči", async ({
  page,
  browser,
  freshApp,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await registerAdmin(page, freshApp.baseURL);
  await page.getByRole("button", { name: "Tmavý" }).click();
  expect(await isDark(page)).toBe(true);

  const other = await browser.newContext({ colorScheme: "light" });
  const tab = await other.newPage();
  await tab.goto(`${freshApp.baseURL}/prihlaseni`);
  await tab.getByLabel("E-mail").fill("admin@example.cz");
  await tab.getByLabel("Heslo", { exact: true }).fill(PASSWORD);
  await tab.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(tab.getByRole("heading", { name: "Přehled" })).toBeVisible();
  await expect.poll(() => isDark(tab)).toBe(true);
  await expect(tab.getByRole("button", { name: "Tmavý" })).toHaveAttribute("aria-pressed", "true");
  await other.close();
});

test("[UI-007] navigace funguje na šířce 390 px bez vodorovného posunu", async ({
  page,
  freshApp,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerAdmin(page, freshApp.baseURL);
  const noOverflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );

  const nav = page.getByRole("navigation", { name: "Hlavní navigace" });
  await expect(nav).toBeHidden();
  expect(await noOverflow()).toBe(true);

  await page.getByRole("button", { name: "Otevřít nabídku" }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", { name: "Faktury" }).click();
  await expect(page.getByRole("heading", { name: "Faktury" })).toBeVisible();
  await expect(nav).toBeHidden();

  for (const path of ["/nastaveni/ucet", "/nastaveni/historie", "/administrace"]) {
    await page.goto(`${freshApp.baseURL}${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Načítání…")).toHaveCount(0);
    expect(await noOverflow(), path).toBe(true);
  }
});

test("zvonek je na mobilu i na počítači vidět právě jednou", async ({ page, freshApp }) => {
  await registerAdmin(page, freshApp.baseURL);
  const bell = page.getByRole("link", { name: /^Upozornění, nepřečtených/ });
  await expect(bell).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(bell).toHaveCount(1);
});

test("[ADM-001] administrátor vidí v navigaci Administraci", async ({ page, freshApp }) => {
  await registerAdmin(page, freshApp.baseURL);
  await expect(
    page
      .getByRole("navigation", { name: "Hlavní navigace" })
      .getByRole("link", { name: "Administrace" }),
  ).toBeVisible();
});

test("[AUTH-006] [AUD-009] účet ukazuje způsoby přihlášení a vlastní historii", async ({
  page,
  freshApp,
}) => {
  await registerAdmin(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/ucet`);
  await expect(page.getByRole("heading", { name: "Způsoby přihlášení" })).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Heslo" })
      .getByRole("button", { name: "Odebrat Heslo" }),
  ).toBeDisabled();
  await expect(page.getByText("Poslední způsob přihlášení nejde odebrat.")).toBeVisible();
  const history = page.getByRole("heading", { name: "Historie účtu" }).locator("..");
  await expect(history.getByText("Nový účet")).toBeVisible();

  await page.goto(`${freshApp.baseURL}/nastaveni/ucet?chyba=propojeni`);
  await expect(page.getByText(/nepodařilo propojit/)).toBeVisible();
});

test("[AUD-007] [EXP-004] historie se filtruje a exportuje do CSV", async ({ page, freshApp }) => {
  await registerAdmin(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/historie`);
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "Nový účet" })).toHaveCount(1);

  await page.getByLabel("Akce").selectOption("auth.first_admin");
  await page.getByRole("button", { name: "Filtrovat" }).click();
  await expect(page).toHaveURL(/action=auth\.first_admin/);
  await expect(rows.filter({ hasText: "Nový účet" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "První administrátor" })).toHaveCount(1);

  await page
    .getByRole("row", { name: /První administrátor/ })
    .getByText("Detail")
    .click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Exportovat CSV" }).click(),
  ]);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain("První administrátor");
  expect(csv).not.toContain("Nový účet");

  await page.goto(`${freshApp.baseURL}/nastaveni/historie`);
  await expect(page.getByRole("row").filter({ hasText: "Export historie" })).toHaveCount(1);
});

test("[AUTH-011] seznam relací označí aktuální a umí ukončit jednu i ostatní", async ({
  page,
  browser,
  freshApp,
}) => {
  await registerAdmin(page, freshApp.baseURL);
  const login = async () => {
    const other = await browser.newContext();
    const tab = await other.newPage();
    await tab.goto(`${freshApp.baseURL}/prihlaseni`);
    await tab.getByLabel("E-mail").fill("admin@example.cz");
    await tab.getByLabel("Heslo", { exact: true }).fill(PASSWORD);
    await tab.getByRole("button", { name: "Přihlásit se" }).click();
    await expect(tab.getByRole("heading", { name: "Přehled" })).toBeVisible();
    return tab;
  };
  const second = await login();
  const third = await login();

  await page.goto(`${freshApp.baseURL}/nastaveni/ucet`);
  const items = page
    .getByRole("region")
    .or(page.locator("section"))
    .filter({ has: page.getByRole("heading", { name: "Aktivní relace" }) })
    .getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: "Tato relace" })).toHaveCount(1);
  await expect(items.filter({ hasText: "Tato relace" }).getByRole("button")).toHaveCount(0);

  await items
    .filter({ hasNotText: "Tato relace" })
    .first()
    .getByRole("button", { name: /^Ukončit/ })
    .click();
  await expect(items).toHaveCount(2);
  await second.reload();
  await expect(second).toHaveURL(/\/prihlaseni$/);
  await third.reload();
  await expect(third.getByRole("heading", { name: "Přehled" })).toBeVisible();

  await page.getByRole("button", { name: "Ukončit ostatní" }).click();
  await expect(items).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Ukončit ostatní" })).toBeDisabled();
  await third.reload();
  await expect(third).toHaveURL(/\/prihlaseni$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Aktivní relace" })).toBeVisible();
});

test("[UI-005] motiv se nastaví ještě před hydratací, bez záblesku světlého", async ({
  page,
  freshApp,
}) => {
  await page.route("**/_next/static/**", (route) => route.abort());
  const html = () => page.evaluate(() => document.documentElement.classList.contains("dark"));

  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("fakturan-theme", "dark"));
  await page.goto(`${freshApp.baseURL}/prihlaseni`, { waitUntil: "domcontentloaded" });
  expect(await html()).toBe(true);

  await page.evaluate(() => localStorage.setItem("fakturan-theme", "light"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("fakturan-theme", "light"));
  await page.goto(`${freshApp.baseURL}/prihlaseni`, { waitUntil: "domcontentloaded" });
  expect(await html()).toBe(false);

  await page.addInitScript(() => localStorage.removeItem("fakturan-theme"));
  await page.goto(`${freshApp.baseURL}/prihlaseni`, { waitUntil: "domcontentloaded" });
  expect(await html()).toBe(true);
});

test("[EXP-004] export se spouští jen POSTem ze stejného původu", async ({ page, freshApp }) => {
  await registerAdmin(page, freshApp.baseURL);
  const url = `${freshApp.baseURL}/nastaveni/historie/export`;
  expect((await page.request.get(url)).status()).toBe(405);
  const foreign = await page.request.post(url, { headers: { origin: "https://evil.example" } });
  expect(foreign.status()).toBe(403);
  const same = await page.request.post(url, { headers: { origin: freshApp.baseURL } });
  expect(same.status()).toBe(200);
  expect(same.headers()["content-type"]).toContain("text/csv");
});
