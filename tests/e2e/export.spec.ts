import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { expect, test } from "./fixtures";
import { register } from "./invoice-helpers";

test.setTimeout(120_000);

const fixture = (name: string) => readFileSync(join("tests", "fixtures", "isdoc", name));

test("[INV-024] hromadná akce vyveze vybrané doklady", async ({ page, freshApp }) => {
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

  const zip = zipSync({
    "faktura-czk.isdoc": new Uint8Array(fixture("faktura-czk.isdoc")),
    "uhrazena.isdoc": new Uint8Array(fixture("uhrazena.isdoc")),
  });
  await page.goto(`${baseURL}/nastaveni/import`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Soubory k importu").setInputFiles({
    name: "faktury.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await page.getByRole("button", { name: "Zpracovat" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Připraveno ke kontrole", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Uložit doklady" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Hotovo", { timeout: 30_000 });

  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Vybrat fakturu 2026-0001", { exact: true }).check();
  const group = page.getByRole("group", { name: "Hromadné akce" });
  await expect(group).toContainText("Vybráno: 1");
  await group.getByRole("button", { name: "Exportovat" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Vybraných dokladů: 1");
  await dialog.getByLabel("Formát").selectOption("csv");
  await expect(dialog).toContainText("počtem položek");
  await dialog.getByRole("button", { name: "Spustit export" }).click();
  await expect(page.getByRole("status")).toContainText("Export běží na pozadí.");
  await page.getByRole("link", { name: "Otevřít exporty" }).click();

  await expect(page).toHaveURL(/\/nastaveni\/export$/);
  const row = page.getByTestId("export-row").first();
  await expect(row.getByTestId("export-status")).toHaveText("Hotovo", { timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("link", { name: "Stáhnout" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^faktury-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), "utf8");
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("2026-0001");
});
