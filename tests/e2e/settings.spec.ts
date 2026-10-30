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
