import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { zipSync } from "fflate";
import { expect, test } from "./fixtures";
import { PASSWORD } from "./invoice-helpers";

test.setTimeout(150_000);

const fixture = (name: string) => readFileSync(join("tests", "fixtures", "isdoc", name));

async function createAdmin(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Správce");
  await page.getByLabel("E-mail").fill("admin@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

async function invitedUser(page: Page, browser: Browser, baseURL: string, email: string) {
  await page.goto(`${baseURL}/administrace`);
  await page.getByRole("tab", { name: "Pozvánky" }).click();
  await page.getByLabel("E-mail pozvaného").fill(email);
  await page.getByRole("button", { name: "Pozvat" }).click();
  const link = page.getByLabel("Odkaz pozvánky");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.getByRole("button", { name: "Pokračovat k registraci" }).click();
  await guest.getByLabel("Jméno").fill("Nový účet");
  await guest.getByLabel("Heslo").fill(PASSWORD);
  await guest.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(guest.getByText(email, { exact: true })).toBeVisible();
  return guest;
}

test("[IMP-010] e2e záloha, nový účet, obnova, shodné faktury", async ({
  page,
  browser,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await createAdmin(page, baseURL);
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
    name: "faktury.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({
        "faktura-czk.isdoc": new Uint8Array(fixture("faktura-czk.isdoc")),
        "uhrazena.isdoc": new Uint8Array(fixture("uhrazena.isdoc")),
      }),
    ),
  });
  await page.getByRole("button", { name: "Zpracovat" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Připraveno ke kontrole", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Uložit doklady" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Hotovo", { timeout: 30_000 });

  await page.goto(`${baseURL}/nastaveni/zaloha`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Vytvořit zálohu" }).click();
  const row = page.getByTestId("backup-row").first();
  await expect(row.getByTestId("backup-status")).toHaveText("Hotovo", { timeout: 30_000 });
  const downloading = page.waitForEvent("download");
  await row.getByRole("link", { name: "Stáhnout" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^fakturan-zaloha-\d{4}-\d{2}-\d{2}\.zip$/);
  const archive = readFileSync(await download.path());

  await page.goto(`${baseURL}/nastaveni/ucet`);
  await expect(page.getByTestId("backup-offer")).toContainText("Poslední záloha:");
  await expect(page.getByTestId("backup-offer")).toContainText("se smazáním zmizí");

  const guest = await invitedUser(page, browser, baseURL, "obnova@example.cz");
  await guest.goto(`${baseURL}/nastaveni/zaloha`);
  await guest.waitForLoadState("networkidle");
  await guest.getByLabel("Soubor zálohy (ZIP)").setInputFiles({
    name: download.suggestedFilename(),
    mimeType: "application/zip",
    buffer: archive,
  });
  await guest.getByRole("button", { name: "Obnovit ze zálohy" }).click();
  await expect(guest.getByTestId("restore-status")).toHaveText("Hotovo", { timeout: 60_000 });

  await guest.goto(`${baseURL}/faktury`);
  await guest.waitForLoadState("networkidle");
  await expect(guest.getByText("2026-0001").first()).toBeVisible();
  await expect(guest.getByText("2026-0004").first()).toBeVisible();

  // A second restore into the now filled account is refused with a clear message.
  await guest.goto(`${baseURL}/nastaveni/zaloha`);
  await guest.waitForLoadState("networkidle");
  await guest.getByLabel("Soubor zálohy (ZIP)").setInputFiles({
    name: "zaloha.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await guest.getByRole("button", { name: "Obnovit ze zálohy" }).click();
  await expect(guest.getByText("Obnova jde jen do prázdného účtu")).toBeVisible();
});
