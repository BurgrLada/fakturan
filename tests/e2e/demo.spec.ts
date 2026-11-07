import { DEMO, expect, test } from "./fixtures";

test.use({ demoMode: true });
test.setTimeout(90_000);

test("[OPS-007] přihlášení ukáže údaje ukázky a Přehled má data", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await page.goto(`${baseURL}/prihlaseni`);
  await expect(page.getByText("Ukázka Fakturanu")).toBeVisible();
  await expect(page.getByText(DEMO.email, { exact: true })).toBeVisible();
  await expect(page.getByText(DEMO.password, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vytvořit první účet" })).toHaveCount(0);

  // The first scheduler tick seeds the account; until then the login is refused.
  await expect(async () => {
    await page.goto(`${baseURL}/prihlaseni`);
    await page.getByLabel("E-mail").fill(DEMO.email);
    await page.getByLabel("Heslo").fill(DEMO.password);
    await page.getByRole("button", { name: "Přihlásit" }).click();
    await expect(page.getByRole("heading", { name: "Přehled", level: 1 })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 45_000 });

  await expect(page.getByText("Dokončete nastavení")).toHaveCount(0);
  const widget = (title: string) => page.getByRole("region", { name: title, exact: true });
  await expect(widget("Fakturováno letos").getByTestId("widget-empty")).toHaveCount(0);
  await expect(widget("Fakturováno letos")).toContainText("Kč");
  await expect(widget("Nejbližší splatnosti").getByTestId("alerts-overdue")).toBeVisible();

  await page.goto(`${baseURL}/registrace`);
  await expect(page.getByText("Přístup je jen na pozvánku")).toBeVisible();
});
