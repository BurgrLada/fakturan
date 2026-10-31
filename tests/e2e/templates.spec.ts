import { expect, test } from "./fixtures";
import { cashInvoice, issue, openForm, ready, settled } from "./invoice-helpers";

test("[TPL-001] [TPL-002] [TPL-003] faktura se uloží jako šablona a z ní vznikne koncept", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  const detail = page.url();

  await page.getByRole("button", { name: "Uložit jako šablonu" }).click();
  await page.getByRole("alertdialog").getByLabel("Název šablony").fill("Měsíční konzultace");
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(page.getByText("Šablona je uložená.")).toBeVisible();

  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Šablony" }).click();
  await expect(page.getByRole("heading", { name: "Šablony faktur" })).toBeVisible();
  const row = page.getByRole("row", { name: /Měsíční konzultace/ });
  await expect(row).toContainText("Alfa s.r.o.");

  await page.getByRole("button", { name: "Vytvořit fakturu: Měsíční konzultace" }).click();
  await page.waitForURL(/\/faktury\/[^/]+\/upravit$/);
  expect(page.url()).not.toContain(detail.split("/").pop()!);
  await expect(page.getByRole("combobox", { name: "Název položky" }).first()).toHaveValue(
    "Konzultace",
  );
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveValue("Alfa s.r.o.");
  await expect(page.getByLabel("Způsob platby")).toHaveValue("cash");
  await settled(page);

  await page.goto(`${baseURL}/faktury`);
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);
});

test("[TPL-001] šablonu lze smazat a seznam je pak prázdný", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  await page.getByRole("button", { name: "Uložit jako šablonu" }).click();
  await page.getByRole("alertdialog").getByLabel("Název šablony").fill("Zrušit mě");
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(page.getByText("Šablona je uložená.")).toBeVisible();

  await page.goto(`${baseURL}/faktury/sablony`);
  await page.getByRole("button", { name: "Smazat: Zrušit mě" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Smazat šablonu" }).click();
  await expect(page.getByText("Zatím tu není žádná šablona")).toBeVisible();
});

test("[TPL-004] šablona s neznámou proměnnou se neuloží", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByLabel("Poznámka").fill("Za {{neco}}");
  await settled(page);
  await issue(page);
  await page.getByRole("button", { name: "Uložit jako šablonu" }).click();
  await page.getByRole("alertdialog").getByLabel("Název šablony").fill("Špatná");
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(page.getByText("Neznámá proměnná: {{neco}}")).toBeVisible();
});
