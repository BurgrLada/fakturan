import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addCustomer, chooseCustomer, fillLine, openForm, settled } from "./invoice-helpers";

const PASSWORD = "správné-kůň-baterie-sponka";

async function register(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

test("[SET-001] průvodce vyplní dodavatele z ARES a jde přeskočit", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await expect(page.getByText("Dokončete nastavení")).toBeVisible();

  await page.getByRole("link", { name: "Pokračovat v průvodci" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Krok 1 z 5")).toBeVisible();

  await page.getByLabel("IČO").fill("27082440");
  await page.getByRole("button", { name: "Načíst z ARES" }).click();
  await expect(page.getByLabel("Jméno nebo firma")).toHaveValue("Alza.cz a.s.");
  await expect(page.getByLabel("Ulice a číslo")).toHaveValue("Jankovcova 1522/53");
  await page.getByRole("button", { name: "Uložit a pokračovat" }).click();

  await expect(page.getByText("Krok 2 z 5")).toBeVisible();
  await page.getByRole("button", { name: "Přeskočit krok" }).click();
  await expect(page.getByText("Krok 3 z 5")).toBeVisible();
  await page.getByRole("button", { name: "Přeskočit krok" }).click();
  await expect(page.getByText("Krok 4 z 5")).toBeVisible();
  await page.getByRole("button", { name: "Přeskočit krok" }).click();
  await expect(page.getByText("Krok 5 z 5")).toBeVisible();

  await page.getByRole("link", { name: "Dokončit později" }).click();
  await expect(page.getByText("Dokončete nastavení")).toBeVisible();

  await page.goto(`${freshApp.baseURL}/nastaveni/dodavatel`);
  await expect(page.getByLabel("Jméno nebo firma")).toHaveValue("Alza.cz a.s.");
});

test("[SET-001] průvodce naváže tam, kde skončil, a po dokončení zmizí z Přehledu", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pruvodce`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("IČO").fill("27082440");
  await page.getByRole("button", { name: "Načíst z ARES" }).click();
  await expect(page.getByLabel("Jméno nebo firma")).toHaveValue("Alza.cz a.s.");
  await page.getByRole("button", { name: "Uložit a pokračovat" }).click();
  await expect(page.getByText("Krok 2 z 5")).toBeVisible();

  await page.goto(`${freshApp.baseURL}/pruvodce`);
  await expect(page.getByText("Krok 2 z 5")).toBeVisible();

  await page.goto(`${freshApp.baseURL}/pruvodce?krok=look`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Jazyk faktury").selectOption("en");
  await page.getByRole("button", { name: "Dokončit" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
  await expect(page.getByText("Dokončete nastavení")).toBeHidden();

  await page.goto(`${freshApp.baseURL}/nastaveni/vychozi`);
  await expect(page.getByLabel("Jazyk faktury")).toHaveValue("en");
});

test("[SET-030] výchozí hodnoty se uloží a neplatná splatnost ukáže chybu", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/vychozi`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Splatnost ve dnech")).toHaveValue("14");

  await page.getByLabel("Splatnost ve dnech").fill("999");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Splatnost musí být celé číslo od 0 do 365 dnů")).toBeVisible();

  await page.getByLabel("Splatnost ve dnech").fill("30");
  await page.getByLabel("Datum vystavení").selectOption("last_day_previous_month");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Splatnost ve dnech")).toHaveValue("30");
  await expect(page.getByLabel("Datum vystavení")).toHaveValue("last_day_previous_month");
});

test("[SET-002] nový účet vidí v UI, co doplnit před vystavením", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await expect(page.getByText("Dokončete nastavení")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pokračovat v průvodci" })).toBeVisible();

  await addCustomer(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "1000");
  await settled(page);
  await page.getByRole("button", { name: "Vystavit" }).click();

  const summary = page.getByRole("alert", { name: "Před vystavením doplňte" });
  await expect(summary).toBeVisible();
  for (const field of ["Jméno nebo firma", "Ulice", "Město", "PSČ", "IČO"]) {
    const link = summary.getByRole("link", { name: `Doplňte u dodavatele: ${field}` });
    await expect(link).toHaveAttribute("href", "/nastaveni/dodavatel");
  }
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/upravit$/);

  await summary.getByRole("link", { name: "Doplňte u dodavatele: IČO" }).click();
  await expect(page.getByText("Před vystavením faktury doplňte:")).toBeVisible();
});
