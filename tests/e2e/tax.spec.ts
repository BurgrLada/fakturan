import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { register } from "./invoice-helpers";

test.setTimeout(120_000);

const DISCLAIMER =
  "Podklad z údajů ve Fakturanu. Nejde o daňové poradenství, před podáním přiznání údaje ověřte u daňového poradce.";

test("[TAX-001] e2e od výběru roku po stažení CSV", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/nastaveni/dodavatel`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Jméno nebo firma").fill("Zkušební s. r. o.");
  await page.getByLabel("Ulice a číslo").fill("Zkušební 1");
  await page.getByLabel("Město").fill("Testov");
  await page.getByLabel("PSČ").fill("123 45");
  await page.getByLabel("IČO").fill("99900017");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByText("Uloženo.").first()).toBeVisible();

  await page.goto(`${baseURL}/nastaveni/import`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Soubory k importu").setInputFiles({
    name: "uhrazena.isdoc",
    mimeType: "application/xml",
    buffer: readFileSync(join("tests", "fixtures", "isdoc", "uhrazena.isdoc")),
  });
  await page.getByRole("button", { name: "Zpracovat" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Připraveno ke kontrole", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Uložit doklady" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Hotovo", { timeout: 30_000 });

  await page.goto(`${baseURL}/prehledy`);
  await page.getByRole("link", { name: "Daňový podklad" }).click();
  await expect(page).toHaveURL(/\/prehledy\/dane/);
  await expect(page.getByTestId("tax-disclaimer")).toContainText(DISCLAIMER);
  await expect(page.getByTestId("tax-review")).toHaveText("text čeká na ověření");

  await page.getByRole("combobox", { name: "Rok" }).selectOption("2025");
  await page.getByRole("button", { name: "Zobrazit" }).click();
  await expect(page).toHaveURL(/rok=2025/);
  await expect(page.getByTestId("tax-total")).toHaveText("0,00 Kč");

  await page.getByRole("combobox", { name: "Rok" }).selectOption("2026");
  await page.getByRole("combobox", { name: "Základ" }).selectOption("uhrada");
  await page.getByRole("button", { name: "Zobrazit" }).click();
  await expect(page).toHaveURL(/rok=2026/);
  await expect(page.getByTestId("tax-total")).toHaveText("4 800,00 Kč");
  await expect(page.getByTestId("tax-estimated")).toContainText("odhadnuté");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Stáhnout CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("danovy-podklad-2026-paid.csv");
  const csv = readFileSync(await download.path(), "utf8").replace(/^﻿/, "");
  const lines = csv.split("\r\n");
  expect(lines[0]).toBe(DISCLAIMER);
  expect(lines.find((line) => line.startsWith("Příjmy za rok 2026"))).toContain("4800,00");
});
