import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function register(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

test("[SET-010] profil dodavatele se uloží a po obnovení zůstane", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/dodavatel`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Před vystavením faktury doplňte:")).toBeVisible();

  await page.getByLabel("IČO").fill("27082440");
  await page.getByLabel("Jméno nebo firma").fill("Jan Novák");
  await page.getByLabel("Ulice a číslo").fill("Dlouhá 1");
  await page.getByLabel("Město").fill("Praha");
  await page.getByLabel("PSČ").fill("110 00");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Jméno nebo firma")).toHaveValue("Jan Novák");
  await expect(page.getByText("Před vystavením faktury doplňte:")).toBeHidden();
});

test("[SET-010] neplatné IČO ukáže chybu", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/dodavatel`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("IČO").fill("12345678");
  await page.getByLabel("Jméno nebo firma").fill("Jan Novák");
  await page.getByLabel("Ulice a číslo").fill("Dlouhá 1");
  await page.getByLabel("Město").fill("Praha");
  await page.getByLabel("PSČ").fill("110 00");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("IČO není platné")).toBeVisible();
});

test("[SET-014] [SET-013] logo a podpis se nahrají a jdou odebrat", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/dodavatel`);
  await page.waitForLoadState("networkidle");
  const file = join(tmpdir(), `fakturan-logo-${Date.now()}.png`);
  writeFileSync(file, PNG);

  await page.getByLabel("Logo na fakturu").setInputFiles(file);
  await expect(page.getByRole("img", { name: "Logo na fakturu" })).toBeVisible();
  await page.getByLabel("Podpis nebo razítko").setInputFiles(file);
  await expect(page.getByRole("img", { name: "Podpis nebo razítko" })).toBeVisible();

  await page.getByRole("button", { name: "Odebrat" }).first().click();
  await expect(page.getByRole("img", { name: "Logo na fakturu" })).toBeHidden();
});

test("[SET-020] účet s českým číslem a zahraniční účet se přidají a první v měně je výchozí", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/ucty`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Název účtu").fill("Provozní");
  await page.getByLabel("Číslo účtu (i s předčíslím)").fill("1234567890");
  await page.getByLabel("Kód banky").fill("2010");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("Účet je uložený.")).toBeVisible();
  await expect(page.getByText("CZ2120100000001234567890")).toBeVisible();

  await page.getByLabel("Název účtu").fill("Euro");
  await page.getByLabel("Měna").selectOption("EUR");
  await page.getByLabel("IBAN").fill("DE89 3704 0044 0532 0130 00");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("DE89370400440532013000")).toBeVisible();
  await expect(page.getByText("Výchozí", { exact: true })).toHaveCount(2);
});

test("[SET-021] výchozí účet jde přepnout a neplatný IBAN ukáže chybu", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/ucty`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Název účtu").fill("Jedna");
  await page.getByLabel("Číslo účtu (i s předčíslím)").fill("1234567890");
  await page.getByLabel("Kód banky").fill("2010");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("Účet je uložený.")).toBeVisible();

  await page.getByLabel("Název účtu").fill("Dvě");
  await page.getByLabel("Číslo účtu (i s předčíslím)").fill("2000145399");
  await page.getByLabel("Kód banky").fill("0800");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByRole("row", { name: /Dvě/ })).toBeVisible();

  await page.getByRole("button", { name: "Nastavit jako výchozí Dvě" }).click();
  await expect(
    page.getByRole("row", { name: /Dvě/ }).getByText("Výchozí", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Jedna/ }).getByText("Výchozí", { exact: true }),
  ).toBeHidden();

  await page.getByRole("button", { name: "Skrýt Jedna" }).click();
  await expect(page.getByRole("row", { name: /Jedna/ }).getByText("Skrytý")).toBeVisible();
  await page.getByRole("button", { name: "Zobrazit Jedna" }).click();
  await expect(page.getByRole("row", { name: /Jedna/ }).getByText("Skrytý")).toBeHidden();

  await page.getByLabel("Název účtu").fill("Špatný");
  await page.getByLabel("IBAN").fill("CZ0000000000000000000000");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("IBAN není platný")).toBeVisible();
});

test("[NUM-008] [NUM-006] předvolba a vlastní šablona se ukážou v náhledu a řada se uloží", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/rady`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("cell", { name: "{RRRR}-{NNN}", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Z{RRRR}-{NNN}" })).toBeVisible();

  await page.getByLabel("Název řady").fill("Exporty");
  await page.getByLabel("Formát").selectOption({ label: "FV-2026-040" });
  await expect(page.getByLabel("Šablona")).toHaveValue("FV-{RRRR}-{NNN}");
  await expect(page.getByTestId("series-preview")).toHaveText(/^FV-\d{4}-001$/);

  await page.getByLabel("Šablona").fill("EX{RR}-{NN}");
  await expect(page.getByLabel("Formát")).toHaveValue("custom");
  await expect(page.getByTestId("series-preview")).toHaveText(/^EX\d{2}-01$/);

  await page.getByLabel("Šablona").fill("EX{RR}");
  await expect(page.getByText("právě jedno pořadí")).toBeVisible();

  await page.getByLabel("Šablona").fill("EX{RR}-{NN}");
  await page.getByRole("button", { name: "Uložit řadu" }).click();
  await expect(page.getByText("Řada je uložená.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Exporty/ })).toBeVisible();
});

test("[NUM-004] další číslo se nastaví a promítne do náhledu", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/rady`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Upravit Faktura" }).click();
  await page.getByLabel("Další číslo").fill("40");
  await expect(page.getByTestId("series-preview")).toHaveText(/^\d{4}-040$/);
  await page.getByRole("button", { name: "Nastavit další číslo" }).click();
  await expect(page.getByText("Další číslo je nastavené.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Faktura/ }).first()).toContainText("-040");
});
