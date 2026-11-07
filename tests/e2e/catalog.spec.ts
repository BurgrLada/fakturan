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

test("[CAT-001] nová položka s cenou 1 234,50 Kč se zobrazí správně", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.getByRole("link", { name: "Ceník" }).first().click();
  await expect(page.getByRole("heading", { name: "Ceník", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Nová položka" }).first().click();
  await expect(page.getByRole("heading", { name: "Nová položka" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Název", { exact: true }).fill("Konzultace");
  await page.getByLabel("Cena za jednotku").fill("1 234,50");
  await page.getByLabel("Jednotka", { exact: true }).selectOption("hod.");
  await page.getByRole("textbox", { name: "Kategorie" }).fill("Služby");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("heading", { name: "Položka ceníku" })).toBeVisible();
  await expect(page.getByLabel("Cena za jednotku")).toHaveValue("1234,50");
  await page.waitForLoadState("networkidle");

  await page.goto(`${freshApp.baseURL}/cenik`);
  await page.waitForLoadState("networkidle");
  const row = page.getByRole("row", { name: /Konzultace/ });
  await expect(row).toContainText("1 234,50 Kč");
  await expect(row).toContainText("hod.");

  await page.getByRole("searchbox", { name: "Hledat" }).fill("konzultace");
  await page.getByRole("button", { name: "Filtrovat" }).click();
  await expect(page).toHaveURL(/q=konzultace/);
  await expect(page.getByRole("link", { name: "Konzultace" })).toBeVisible();
});

test("[CAT-004] vlastní jednotka se nabídne ve formuláři položky", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/cenik`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("projekt", { exact: true })).toBeVisible();
  await page.getByLabel("Nová jednotka").fill("balení");
  await page.getByRole("button", { name: "Přidat jednotku" }).click();
  await expect(page.getByText("Jednotka je přidaná.")).toBeVisible();

  await page.goto(`${freshApp.baseURL}/cenik/novy`);
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByLabel("Jednotka", { exact: true }).locator("option", { hasText: "balení" }),
  ).toHaveCount(1);
});
