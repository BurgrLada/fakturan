import type { Page } from "@playwright/test";
import { startSmtp } from "../helpers/smtp";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";
const SMTP_PASSWORD = "tajne-heslo-smtp-9f3a";

async function register(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

async function openPage(page: Page, baseURL: string) {
  await register(page, baseURL);
  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.waitForLoadState("networkidle");
}

test("[SET-053] bez SMTP stránka vysvětlí proč a zkušební zpráva nejde poslat", async ({
  page,
  freshApp,
}) => {
  await openPage(page, freshApp.baseURL);

  await expect(page.getByRole("heading", { name: "Pošta", level: 1 })).toBeVisible();
  await expect(page.getByText("Odesílání e-mailů není dostupné")).toBeVisible();
  await expect(page.getByText("Stahování PDF funguje dál")).toBeVisible();
  await expect(page.getByRole("button", { name: "Poslat zkušební e-mail" })).toBeDisabled();
});

test("[SEC-007] privátní server stránka odmítne", async ({ page, freshApp }) => {
  await openPage(page, freshApp.baseURL);

  await page.getByLabel("Server", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port").fill("587");
  await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
  await page.getByRole("button", { name: "Uložit" }).click();

  await expect(page.getByRole("status")).toContainText("Tento server pošty není povolený");
  await page.reload();
  await expect(page.getByLabel("Server", { exact: true })).toHaveValue("");
});

test.describe("vlastní server", () => {
  test.use({ allowPrivateMail: true });

  test("[SET-051] vlastní server se uloží, otestuje a smaže", async ({ page, freshApp }) => {
    const smtp = await startSmtp();
    try {
      await openPage(page, freshApp.baseURL);

      await page.getByLabel("Jméno odesílatele").fill("Jan Novák");
      await page.getByLabel("Server", { exact: true }).fill("127.0.0.1");
      await page.getByLabel("Port").fill(String(smtp.port));
      await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
      await page.getByLabel("Uživatel").fill("jan");
      await page.getByLabel("Heslo").fill(SMTP_PASSWORD);
      await page.getByRole("button", { name: "Uložit" }).click();
      await expect(page.getByRole("status")).toContainText("Nastavení pošty je uložené");

      await page.reload();
      await expect(page.getByLabel("Heslo")).toHaveValue("");
      await expect(page.locator("html")).not.toContainText(SMTP_PASSWORD);
      await expect(page.getByText("Heslo je uložené")).toBeVisible();
      await expect(page.getByText("přes váš vlastní SMTP server")).toBeVisible();

      await page.getByRole("button", { name: "Poslat zkušební e-mail" }).click();
      await expect(page.getByRole("status")).toContainText("Zkušební e-mail je odeslaný");
      await smtp.waitFor("jan@example.cz");
      await expect(page.getByText("ověřený zkušební zprávou")).toBeVisible();

      await page.getByRole("button", { name: "Smazat vlastní SMTP" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Smazat vlastní SMTP" })
        .click();
      await expect(page.getByRole("status")).toContainText("Vlastní SMTP je smazané");

      await page.reload();
      await expect(page.getByText("Odesílání e-mailů není dostupné")).toBeVisible();
      await expect(page.getByLabel("Server", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Jméno odesílatele")).toHaveValue("Jan Novák");
    } finally {
      await smtp.stop();
    }
  });
});
