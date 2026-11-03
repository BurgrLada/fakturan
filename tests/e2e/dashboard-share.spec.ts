import { readFileSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addCustomer, addSupplier, PASSWORD } from "./invoice-helpers";
import { accountWithInvoice, cashInvoice, money } from "./report-helpers";

test.setTimeout(120_000);

const card = (page: Page, title: string) =>
  page.getByTestId("dashboard-grid").getByRole("region", { name: title, exact: true });
const previewWidget = (page: Page, title: string) =>
  page.getByTestId("import-widget").filter({ has: page.getByRole("heading", { name: title }) });

async function openEditor(page: Page, baseURL: string) {
  await page.goto(baseURL);
  await page.getByRole("link", { name: "Upravit dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Úpravy dashboardu", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function download(page: Page, button: ReturnType<Page["getByRole"]>): Promise<string> {
  const pending = page.waitForEvent("download");
  await button.click();
  const file = await pending;
  return readFileSync((await file.path())!, "utf8");
}

async function importFile(page: Page, path: string) {
  await page.getByRole("button", { name: "Importovat JSON" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Import dashboardu z JSON" })).toBeVisible();
  await dialog.getByLabel("Soubor JSON").setInputFiles(path);
  return dialog;
}

async function invitedAccount(browser: Browser, page: Page, baseURL: string) {
  await page.goto(`${baseURL}/administrace`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Pozvánky" }).click();
  await page.getByLabel("E-mail pozvaného").fill("eva@example.cz");
  await page.getByRole("button", { name: "Pozvat" }).click();
  const link = await page.getByLabel("Odkaz pozvánky").inputValue();
  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto(link);
  await other.getByRole("button", { name: "Pokračovat k registraci" }).click();
  await expect(other).toHaveURL(/\/registrace$/);
  await other.getByLabel("Jméno").fill("Eva Dvořáková");
  await other.getByLabel("Heslo").fill(PASSWORD);
  await other.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(other.getByText("eva@example.cz", { exact: true })).toBeVisible();
  await addSupplier(other, baseURL);
  await addCustomer(other, baseURL);
  return { context, page: other };
}

test("[DSH-032] export z účtu A a import do účtu B ukáže jen data B", async ({
  page,
  browser,
  freshApp,
}, testInfo) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await openEditor(page, baseURL);
  const text = await download(page, page.getByRole("button", { name: "Exportovat JSON" }));
  const file = JSON.parse(text);
  expect(file).toMatchObject({ format: "fakturan.dashboard", v: 1, name: "Přehled" });
  for (const secret of ["Alfa", "1000", "1 000", "jan@example.cz", '"id"']) {
    expect(text).not.toContain(secret);
  }
  const path = testInfo.outputPath("dashboard-a.json");
  writeFileSync(path, text);

  const other = await invitedAccount(browser, page, baseURL);
  await cashInvoice(other.page, baseURL, "2500");
  await openEditor(other.page, baseURL);
  const dialog = await importFile(other.page, path);
  const invoiced = previewWidget(other.page, "Fakturováno letos");
  await expect(invoiced.getByTestId("widget-value")).toHaveText(money("2 500,00 Kč"));
  await expect(previewWidget(other.page, "Pohledávky").getByTestId("widget-value")).toHaveText(
    money("2 500,00 Kč"),
  );
  await expect(
    dialog.getByTestId("widget-value").filter({ hasText: money("1 000,00 Kč") }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Náhled: Přehled (2)")).toBeVisible();

  await dialog.getByRole("button", { name: "Importovat", exact: true }).click();
  await expect(other.page).toHaveURL(/\/dashboardy\/[^/]+\/upravit$/);
  await expect(other.page.getByText("Přehled (2)", { exact: true })).toBeVisible();
  await other.page.goto(baseURL);
  await other.page.getByRole("link", { name: "Přehled (2)" }).click();
  await expect(card(other.page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("2 500,00 Kč"),
  );
  await other.context.close();

  await page.goto(baseURL);
  await expect(page.getByRole("link", { name: "Přehled (2)" })).toHaveCount(0);
  await expect(card(page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("1 000,00 Kč"),
  );
});

test("přizpůsobení dashboardu a import JSON od začátku do konce", async ({
  page,
  freshApp,
}, testInfo) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await openEditor(page, baseURL);

  await page.getByRole("link", { name: "Přidat widget" }).click();
  await page.getByRole("link", { name: "Přidat widget Podíl měn" }).click();
  await expect(page.getByRole("heading", { name: "Nový widget" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název").fill("Měny letos");
  await page.getByRole("button", { name: "Přidat na dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Úpravy dashboardu", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const widgetText = await download(
    page,
    page.getByRole("button", { name: "Exportovat widget Měny letos jako JSON" }),
  );
  expect(JSON.parse(widgetText)).toMatchObject({
    name: "Měny letos",
    widgets: [{ kind: "query", title: "Měny letos", display: "donut" }],
  });
  const dashboardText = await download(page, page.getByRole("button", { name: "Exportovat JSON" }));
  const path = testInfo.outputPath("dashboard.json");
  writeFileSync(path, dashboardText);

  const broken = testInfo.outputPath("broken.json");
  const parsed = JSON.parse(dashboardText);
  parsed.widgets[1] = { ...parsed.widgets[1], groupBy: "item" };
  writeFileSync(broken, JSON.stringify(parsed));
  let dialog = await importFile(page, broken);
  await expect(dialog.getByTestId("import-error")).toHaveText(
    "widgets[1].groupBy: Zdroj toto seskupení nemá",
  );
  await expect(dialog.getByRole("button", { name: "Importovat", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Zrušit" }).click();

  dialog = await importFile(page, path);
  await expect(previewWidget(page, "Měny letos")).toBeVisible();
  await expect(dialog.getByTestId("import-widget")).toHaveCount(parsed.widgets.length);
  await dialog.getByRole("button", { name: "Importovat", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboardy\/[^/]+\/upravit$/);
  await expect(page.getByText("Přehled (2)", { exact: true })).toBeVisible();

  await page.goto(baseURL);
  await page.getByRole("link", { name: "Přehled (2)" }).click();
  await expect(card(page, "Měny letos")).toBeVisible();
  await expect(card(page, "Nejbližší splatnosti")).toBeVisible();
  await expect(card(page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("1 000,00 Kč"),
  );
});
