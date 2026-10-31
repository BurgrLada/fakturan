import type { Page } from "@playwright/test";
import { startImap } from "../helpers/imap";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";
const IMAP_PASSWORD = "tajne-heslo-imap-4c1d";

async function openPage(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
  await page.goto(`${baseURL}/nastaveni/aviza`);
  await page.waitForLoadState("networkidle");
}

test("[BNK-002] stránka ukáže kroky nastavení ve Fio", async ({ page, freshApp }) => {
  await openPage(page, freshApp.baseURL);

  await expect(page.getByRole("heading", { name: "Avíza z banky", level: 1 })).toBeVisible();
  await expect(page.getByText("Doporučujeme samostatnou e-mailovou schránku")).toBeVisible();
  const steps = page.getByRole("list").filter({ hasText: "Uživatelská oznámení" });
  await expect(steps.getByRole("listitem")).toHaveCount(8);
  await expect(steps).toContainText("Nastavení, potom Oznámení a Uživatelská oznámení");
  await expect(steps).toContainText("Pohyby");
  await expect(steps).toContainText("Přidat oznámení");
  await expect(steps).toContainText("0,01");
  await expect(steps).toContainText("Fio banka - příjem na účtu");
  await expect(steps).toContainText("Posílat online");
  await expect(page.getByText("Schránka není nastavená")).toBeVisible();
  await expect(page.getByRole("button", { name: "Vyzkoušet připojení" })).toBeDisabled();
  await expect(page.getByText("Kdo zná číslo vaší faktury")).toBeVisible();
});

test("[SEC-007] privátní server stránka odmítne", async ({ page, freshApp }) => {
  await openPage(page, freshApp.baseURL);

  await page.getByLabel("Server IMAP").fill("127.0.0.1");
  await page.getByLabel("Uživatel").fill("avizo");
  await page.getByLabel("Heslo").fill(IMAP_PASSWORD);
  await page.getByRole("button", { name: "Uložit" }).click();

  await expect(page.getByRole("status")).toContainText("Tento server pošty není povolený");
  await page.reload();
  await expect(page.getByLabel("Server IMAP")).toHaveValue("");
});

test.describe("vlastní schránka", () => {
  test.use({ allowPrivateMail: true });

  test("[BNK-001] schránka se uloží, vyzkouší a smaže, heslo se nevrací", async ({
    page,
    freshApp,
  }) => {
    const imap = await startImap();
    try {
      await openPage(page, freshApp.baseURL);

      await page.getByLabel("Server IMAP").fill("127.0.0.1");
      await page.getByLabel("Port").fill(String(imap.port));
      await page.getByLabel("Šifrování").selectOption("starttls");
      await page.getByLabel("Uživatel").fill("avizo");
      await page.getByLabel("Heslo").fill(IMAP_PASSWORD);
      await page.getByRole("button", { name: "Uložit" }).click();
      await expect(page.getByRole("status")).toContainText("Nastavení schránky je uložené");

      await page.reload();
      await expect(page.getByLabel("Heslo")).toHaveValue("");
      await expect(page.locator("html")).not.toContainText(IMAP_PASSWORD);
      await expect(page.getByText("Heslo je uložené")).toBeVisible();
      await expect(page.getByText("Vyžadovat potvrzení")).toBeVisible();
      await expect(page.getByLabel("Vyžadovat potvrzení")).toBeChecked();

      imap.addMessage(
        [
          "Authentication-Results: mx.vlastni.cz; dkim=pass header.d=fio.cz",
          "From: Fio banka <automat@fio.cz>",
          "Subject: Fio banka - new income on account",
          "",
          "Text",
        ].join("\r\n"),
      );
      await page.getByRole("button", { name: "Vyzkoušet připojení" }).click();
      await expect(page.getByRole("status")).toContainText("Připojení funguje");
      await page.getByRole("button", { name: "Použít", exact: true }).click();
      await expect(page.getByLabel("Server ověření (authserv-id)")).toHaveValue("mx.vlastni.cz");
      await expect(page.getByText("Připojení ověřené testem")).toBeVisible();
      // The scheduler polls a saved mailbox as well, so the count may be higher.
      expect(imap.logins.length).toBeGreaterThanOrEqual(1);

      await page.getByLabel("Server IMAP").fill("localhost");
      await page.getByRole("button", { name: "Uložit" }).click();
      await expect(page.getByRole("status")).toContainText("zadejte heslo znovu");

      await page.getByRole("button", { name: "Smazat schránku" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Smazat schránku" }).click();
      await expect(page.getByRole("status")).toContainText("Schránka je smazaná");

      await page.reload();
      await expect(page.getByText("Schránka není nastavená")).toBeVisible();
      await expect(page.getByLabel("Server IMAP")).toHaveValue("");
    } finally {
      await imap.close();
    }
  });
});
