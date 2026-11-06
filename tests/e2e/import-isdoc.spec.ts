import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { expect, test } from "./fixtures";
import { register } from "./invoice-helpers";

test.setTimeout(120_000);

const fixture = (name: string) => readFileSync(join("tests", "fixtures", "isdoc", name));

test("[IMP-000] od ZIPu po detail s štítkem a vrácení dávky", async ({ page, freshApp }) => {
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
  await expect(page.getByRole("table", { name: "Náhled importu" })).toContainText("2026-0001");
  await expect(page.getByText("Uhrazených z importu: 1.")).toBeVisible();
  const batchUrl = page.url();

  await page.getByRole("button", { name: "Uložit doklady" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Hotovo", { timeout: 30_000 });

  await page.goto(`${baseURL}/faktury?jinde=1`);
  await page.getByRole("link", { name: "2026-0001", exact: true }).click();
  await expect(page.getByTestId("invoice-source")).toHaveText(
    "Vytvořeno jinde: Zkušební systém 1.0",
  );
  await expect(page.getByRole("button", { name: "Upravit" })).toHaveCount(0);

  await page.goto(batchUrl);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Vrátit import" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Vráceno");
  await page.goto(`${baseURL}/faktury`);
  await expect(page.getByText("Zatím tu není žádná faktura")).toBeVisible();
});

test("[IMP-005] e2e přiložení PDF na detailu importovaného dokladu", async ({ page, freshApp }) => {
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
    name: "faktura-czk.isdoc",
    mimeType: "application/xml",
    buffer: fixture("faktura-czk.isdoc"),
  });
  await page.getByRole("button", { name: "Zpracovat" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Připraveno ke kontrole", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Uložit doklady" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Hotovo", { timeout: 30_000 });

  await page.goto(`${baseURL}/faktury?jinde=1`);
  await page.getByRole("link", { name: "2026-0001", exact: true }).click();
  await expect(page.getByRole("link", { name: "Původní PDF" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Přiložit PDF" })).toBeVisible();

  await page.getByTestId("import-pdf-input").setInputFiles({
    name: "faktura.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  const original = page.getByRole("link", { name: "Původní PDF" });
  await expect(original).toBeVisible();
  await expect(page.getByRole("button", { name: "Nahradit PDF" })).toBeVisible();
  const href = await original.getAttribute("href");
  const download = await page.request.get(`${baseURL}${href}`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toBe("application/pdf");

  await page.getByTestId("import-pdf-input").setInputFiles({
    name: "obrazek.png",
    mimeType: "image/png",
    buffer: Buffer.from("PNG"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "Soubor není PDF" })).toBeVisible();
});
