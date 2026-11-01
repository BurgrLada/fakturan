import { expect, test } from "./fixtures";
import {
  addCustomer,
  addSupplier,
  chooseCustomer,
  fillLine,
  issue,
  register,
  settled,
} from "./invoice-helpers";

test.setTimeout(90_000);

const money = (text: string) => new RegExp(text.replace(/ /g, "\\s"));

test("záloha, úhrada, faktura", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);

  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová záloha" }).click();
  await expect(page.getByRole("heading", { name: "Nová záloha" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await chooseCustomer(page);
  await fillLine(page, 0, "Záloha na web", "10000");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await settled(page);
  await issue(page);
  await expect(page.getByRole("heading", { name: /Zálohová faktura Z\d{4}-001/ })).toBeVisible();
  const advanceUrl = page.url().split("?")[0]!;

  await page.goto(`${baseURL}/faktury`);
  await expect(page.getByTestId("summary-advance-open")).toHaveText(money("10 000,00 Kč"));
  await expect(page.getByTestId("summary-CZK")).toContainText("Neuhrazené zálohy");

  await page.goto(advanceUrl);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("10 000,00 Kč"));

  await page.getByRole("button", { name: "Vytvořit konečnou fakturu" }).click();
  await expect(page.getByRole("heading", { name: "Koncept faktury" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await issue(page);

  await expect(page.getByRole("heading", { name: /Faktura \d{4}-001/ })).toBeVisible();
  const steps = page.getByTestId("invoice-steps");
  await expect(steps).toContainText("Uhrazeno zálohou");
  await expect(steps).toContainText(money("Zbývá uhradit0,00 Kč"));
  const related = page.getByTestId("related-documents");
  await expect(related).toContainText("Záloha");
  await related.getByRole("link").click();

  await expect(page).toHaveURL(advanceUrl);
  await page.goto(advanceUrl);
  await expect(page.getByTestId("related-documents")).toContainText("Nahrazeno fakturou");
  await expect(page.getByText("Nahrazená")).toBeVisible();
  await expect(page.getByRole("button", { name: "Přidat platbu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vytvořit konečnou fakturu" })).toHaveCount(0);
  await expect(page.getByTestId("cancel-blocked")).toBeVisible();
  await expect(page.getByTestId("payment-panel")).toBeVisible();
});

test("plán pravidelné faktury nabízí zálohu a text zálohy jde upravit", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);

  await expect(page.getByLabel("Text na záloze (česky)")).toHaveValue("Toto není daňový doklad.");

  await page.goto(`${baseURL}/pravidelne/nova`);
  const type = page.getByLabel("Typ dokladu");
  await expect(type.locator("option")).toHaveText(["Faktura", "Zálohová faktura"]);
});
