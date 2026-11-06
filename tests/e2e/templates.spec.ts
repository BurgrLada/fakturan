import { expect, test } from "./fixtures";
import {
  cashInvoice,
  chooseCurrency,
  chooseCustomer,
  fillLine,
  issue,
  issuedPdf,
  openForm,
  ready,
  settled,
} from "./invoice-helpers";
import type { Page } from "@playwright/test";
import { calendarDateInPrague } from "@/lib/number-format";

async function saveFormAsTemplate(page: Page, name: string) {
  await page.getByRole("button", { name: "Uložit jako šablonu" }).click();
  await page.getByRole("alertdialog").getByLabel("Název šablony").fill(name);
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(page.getByText("Šablona je uložená.")).toBeVisible();
}

async function eurTemplate(page: Page, baseURL: string) {
  await openForm(page, baseURL);
  await chooseCurrency(page, "EUR");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "1000");
  await settled(page);
  await saveFormAsTemplate(page, "Eurová");
  await page.goto(`${baseURL}/faktury/sablony`);
  await page.getByRole("button", { name: "Vytvořit fakturu: Eurová" }).click();
  await page.waitForURL(/\/faktury\/[^/]+\/upravit$/);
  await page.waitForLoadState("networkidle");
}

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

test("[TPL-004] šablona z konceptu zachová {{rok}} a vystavení ho dosadí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  const year = Number(calendarDateInPrague(new Date()).slice(0, 4));
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await fillLine(page, 0, "Hosting {{rok}}", "1000");
  await saveFormAsTemplate(page, "Hosting");

  await page.goto(`${baseURL}/faktury/sablony`);
  await page.getByRole("button", { name: "Vytvořit fakturu: Hosting" }).click();
  await page.waitForURL(/\/faktury\/[^/]+\/upravit$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("combobox", { name: "Název položky" })).toHaveValue(
    "Hosting {{rok}}",
  );

  await issue(page);
  const pdf = await issuedPdf(page);
  expect(pdf).toContain(`Hosting ${year}`);
  expect(pdf).not.toContain("{{rok}}");
});

test("[TPL-003] vystavený doklad při uložení šablony upozorní na dosazené hodnoty", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);

  await page.getByRole("button", { name: "Uložit jako šablonu" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("hodnoty už dosazené");
});

test("[INV-010] šablona v EUR a zákazník s CZK měnu nezmění, výchozí hodnoty jen nabídne", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await eurTemplate(page, baseURL);

  await chooseCustomer(page);

  const offer = page.getByTestId("customer-defaults");
  await expect(offer).toContainText("CZK");
  await expect(page.getByLabel("Měna")).toHaveValue("EUR");
  await expect(page.getByLabel("Způsob platby")).toHaveValue("cash");

  await offer.getByRole("button", { name: "Ponechat" }).click();
  await expect(offer).toBeHidden();
  await expect(page.getByLabel("Měna")).toHaveValue("EUR");

  await page.getByLabel("Kurz k CZK").fill("25,5");
  await settled(page);
  await page.getByRole("button", { name: "Vystavit" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Alfa s.r.o.");
  await expect(dialog).toContainText(/1\s000,00\s€/);
});

test("[INV-010] nabízené výchozí hodnoty zákazníka jde jedním kliknutím převzít", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await eurTemplate(page, baseURL);
  await chooseCustomer(page);

  await page
    .getByTestId("customer-defaults")
    .getByRole("button", { name: "Použít výchozí hodnoty" })
    .click();

  await expect(page.getByLabel("Zahraniční faktura")).not.toBeChecked();
  await expect(page.getByLabel("Měna")).toHaveCount(0);
  await expect(page.getByLabel("Kurz k CZK")).toHaveCount(0);
  await expect(page.getByLabel("Způsob platby")).toHaveValue("transfer");
  await expect(page.getByTestId("customer-defaults")).toBeHidden();
});
