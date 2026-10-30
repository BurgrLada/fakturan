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

async function openDesigns(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/nastaveni/designy`);
  await page.waitForLoadState("networkidle");
}

test("[PDF-004] výběr designu změní náhled a uloží se", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await openDesigns(page, freshApp.baseURL);
  const preview = page.getByTitle("Náhled faktury");
  await expect(preview).toHaveCount(1);
  await expect(page.getByRole("radio")).toHaveCount(12);
  await expect(preview).toHaveAttribute("src", /design=cisty/);

  await page.getByRole("radio", { name: "Mono" }).check();
  await expect(preview).toHaveAttribute("src", /design=mono/);
  const src = await preview.getAttribute("src");
  const pdf = await page.request.get(`${freshApp.baseURL}${src}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  await page.getByLabel("Umístění loga").selectOption("right");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("radio", { name: "Mono" })).toBeChecked();
  await expect(page.getByLabel("Umístění loga")).toHaveValue("right");
});

test("[PDF-003] nízký kontrast ukáže varování a uložení nezablokuje, prázdná barva je design", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await openDesigns(page, freshApp.baseURL);

  await page.getByLabel("Text", { exact: true }).fill("#dddddd");
  await expect(page.getByText(/kontrast jen/).first()).toBeVisible();
  await expect(page.getByTitle("Náhled faktury")).toHaveAttribute("src", /text=%23dddddd/);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue("#dddddd");

  await page.getByRole("button", { name: "Barva designu: Text" }).click();
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue("");
  await expect(page.getByText(/kontrast jen/)).toHaveCount(0);
});

test("[PDF-009] šablona názvu PDF a zaokrouhlení jdou nastavit ve výchozích hodnotách", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/vychozi`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Název souboru PDF").fill("FA {cislo}.pdf");
  await page.getByLabel("Zaokrouhlení celkové částky").selectOption("whole");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Název souboru PDF")).toHaveValue("FA {cislo}.pdf");
  await expect(page.getByLabel("Zaokrouhlení celkové částky")).toHaveValue("whole");
});
