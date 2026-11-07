import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";

async function register(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

async function addCustomer(page: Page, baseURL: string, name: string, country?: string) {
  await page.goto(`${baseURL}/zakaznici/novy`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název nebo jméno").fill(name);
  if (country) await page.getByLabel("Stát").fill(country);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("heading", { name: "Karta zákazníka" })).toBeVisible();
  await expect(page).toHaveURL(/\/zakaznici\/(?!novy)[\w-]+$/);
}

test("[CUS-004] nový zákazník předvyplněný z ARES", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/zakaznici`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Nový zákazník" }).first().click();
  await page.waitForLoadState("networkidle");

  await page.getByLabel("IČO").fill("27082440");
  await page.getByRole("button", { name: "Načíst z ARES" }).click();
  await expect(page.getByLabel("Název nebo jméno")).toHaveValue("Alza.cz a.s.");
  await expect(page.getByLabel("Ulice a číslo")).toHaveValue("Jankovcova 1522/53");
  await page.getByRole("button", { name: "Uložit" }).click();

  await expect(page.getByRole("heading", { name: "Karta zákazníka" })).toBeVisible();
  await expect(page.getByLabel("Název nebo jméno")).toHaveValue("Alza.cz a.s.");
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Poznámka").fill("Platí vždy předem");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Zákazník je uložený.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Zákazník je uložený.")).toBeVisible();
  await expect(page.getByText("Uložení zákazníka").first()).toBeVisible();

  await page.goto(`${freshApp.baseURL}/zakaznici`);
  await expect(page.getByRole("link", { name: "Alza.cz a.s." })).toBeVisible();
});

test("[CUS-004] nedostupný ARES nebrání ručnímu vyplnění", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/zakaznici/novy`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("IČO").fill("12345679");
  await page.getByRole("button", { name: "Načíst z ARES" }).click();
  await expect(page.getByText("ARES nic nenašel nebo neodpovídá")).toBeVisible();

  await page.getByLabel("Název nebo jméno").fill("Ruční s.r.o.");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("heading", { name: "Karta zákazníka" })).toBeVisible();
});

test("[CUS-001] hledání a filtr přežijí obnovení stránky", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await addCustomer(page, freshApp.baseURL, "Alfa s.r.o.");
  await addCustomer(page, freshApp.baseURL, "Beta GmbH", "Německo");

  await page.goto(`${freshApp.baseURL}/zakaznici`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "Alfa s.r.o." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beta GmbH" })).toBeVisible();

  await page.getByLabel("Původ").selectOption("1");
  await page.getByRole("button", { name: "Filtrovat" }).click();
  await expect(page).toHaveURL(/zahranici=1/);
  await expect(page.getByRole("link", { name: "Alfa s.r.o." })).toBeHidden();

  await page.getByLabel("Původ").selectOption("");
  await page.getByRole("searchbox", { name: "Hledat" }).fill("ALF");
  await page.getByRole("button", { name: "Filtrovat" }).click();
  await expect(page).toHaveURL(/q=ALF/);

  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Hledat" })).toHaveValue("ALF");
  await expect(page.getByRole("link", { name: "Alfa s.r.o." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beta GmbH" })).toBeHidden();
});

test("[CUS-007] archivovaný zákazník zmizí ze seznamu a jde obnovit", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await addCustomer(page, freshApp.baseURL, "Gama a.s.");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Archivovat" }).click();
  await expect(page.getByRole("button", { name: "Obnovit" })).toBeVisible();

  await page.goto(`${freshApp.baseURL}/zakaznici`);
  await expect(page.getByRole("link", { name: "Gama a.s." })).toBeHidden();
  await page.goto(`${freshApp.baseURL}/zakaznici?stav=archivovani`);
  await expect(page.getByRole("link", { name: "Gama a.s." })).toBeVisible();
});

test("[SEC-002] neznámý zákazník a neznámá položka ceníku vrátí skutečný stav 404", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);

  const customer = await page.goto(`${freshApp.baseURL}/zakaznici/neexistuje`);
  expect(customer?.status()).toBe(404);
  const item = await page.goto(`${freshApp.baseURL}/cenik/neexistuje`);
  expect(item?.status()).toBe(404);
  const create = await page.goto(`${freshApp.baseURL}/zakaznici/novy`);
  expect(create?.status()).toBe(200);
});
