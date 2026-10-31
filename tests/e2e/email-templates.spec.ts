import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";

async function openTemplates(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
  await page.goto(`${baseURL}/nastaveni/posta/sablony`);
  await page.waitForLoadState("networkidle");
}

test("[MAIL-003] vrácení výchozí šablony ukáže výchozí text a další uložení ho nepřepíše", async ({
  page,
  freshApp,
}) => {
  await openTemplates(page, freshApp.baseURL);
  const card = page.getByRole("form", { name: "Faktura", exact: true });
  const subject = card.getByLabel("Předmět");
  const body = card.getByLabel("Text zprávy");
  const original = {
    subject: await subject.inputValue(),
    body: await body.inputValue(),
  };
  const reset = card.getByRole("button", { name: "Vrátit výchozí" });
  await expect(reset).toBeDisabled();

  await subject.fill("Vlastní předmět");
  await body.fill("Vlastní text");
  await card.getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(card.getByRole("status")).toContainText("Šablona je uložená");
  await expect(reset).toBeEnabled();

  await reset.click();

  await expect(card.getByRole("status")).toContainText("vrácená na výchozí znění");
  await expect(subject).toHaveValue(original.subject);
  await expect(body).toHaveValue(original.body);
  await expect(reset).toBeDisabled();

  await card.getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(card.getByRole("status")).toContainText("Šablona je uložená");
  await page.reload();
  await expect(
    page.getByRole("form", { name: "Faktura", exact: true }).getByLabel("Předmět"),
  ).toHaveValue(original.subject);
});
