import { join } from "node:path";
import type { Browser } from "@playwright/test";
import Database from "better-sqlite3";
import { addDays } from "@/lib/invoice";
import { calendarDateInPrague } from "@/lib/number-format";
import { expect, test } from "./fixtures";
import {
  addCustomer,
  addSupplier,
  chooseCustomer,
  fillLine,
  issue,
  PASSWORD,
  register,
  settled,
} from "./invoice-helpers";
import { accountWithInvoice, cashInvoice, money, openReports, reportTabs } from "./report-helpers";

test.setTimeout(120_000);

const SIX = ["Fakturace", "Úhrady", "Pohledávky", "Zákazníci", "Položky", "Měny"];

test("[REP-001] Statistiky ukazují všech šest přehledů a filtr období s porovnáním", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL);
  await openReports(page, baseURL);
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("1 000,00 Kč"));
  const filter = page.getByRole("form", { name: "Filtr statistik" });
  await expect(filter.getByRole("combobox", { name: "Období", exact: true })).toHaveValue("rok");
  await expect(filter.getByRole("combobox", { name: "Porovnat s", exact: true })).toHaveValue(
    "predchozi",
  );
  for (const name of SIX) {
    await reportTabs(page).getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
    await expect(reportTabs(page).getByRole("link", { name })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("report-table")).toBeVisible();
  }
  await expect(page.getByTestId("report-table")).toContainText("CZK");

  await filter.getByRole("combobox", { name: "Období", exact: true }).selectOption("mesic");
  await filter.getByRole("button", { name: "Použít" }).click();
  await expect(page).toHaveURL(/zalozka=meny/);
  await expect(page).toHaveURL(/obdobi=mesic/);
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("1 000,00 Kč"));
  await page.goto(`${baseURL}/prehledy?obdobi=minuly-rok`);
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("0,00 Kč"));
});

test("[REP-001] porovnání s minulým rokem ukáže hodnotu i rozdíl", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1500");
  await openReports(page, baseURL);
  const filter = page.getByRole("form", { name: "Filtr statistik" });
  await filter.getByRole("combobox", { name: "Porovnat s", exact: true }).selectOption("rok");
  await filter.getByRole("button", { name: "Použít" }).click();
  await expect(page).toHaveURL(/porovnani=rok/);
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("1 500,00 Kč"));
  await expect(page.getByTestId("previous-invoiced")).toHaveText(money("0,00 Kč"));
  await expect(page.getByTestId("change-invoiced")).toHaveText(money("+1 500,00 Kč"));
  await expect(page.getByTestId("report-table")).toContainText("Stejné období loni");
});

test("[REP-002] pohledávky ukazují pásma a vlastní řádek záloh", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  const invoiceUrl = await accountWithInvoice(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová záloha" }).click();
  await expect(page.getByRole("heading", { name: "Nová záloha" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await chooseCustomer(page);
  await fillLine(page, 0, "Záloha na web", "10000");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await settled(page);
  await issue(page);

  const due = addDays(calendarDateInPrague(new Date()), -45);
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite
    .prepare("UPDATE invoice SET due_date = ? WHERE id = ?")
    .run(due, invoiceUrl.split("/").at(-1));
  sqlite.close();

  await openReports(page, baseURL, "?zalozka=pohledavky");
  const table = page.getByTestId("report-table");
  await expect(table.getByRole("row", { name: /31–60 dní po splatnosti/ })).toContainText(
    money("1 000,00 Kč"),
  );
  await expect(table.getByRole("row", { name: /^Ve splatnosti/ })).toContainText(money("0,00 Kč"));
  await expect(table.getByRole("row", { name: /Pohledávky celkem/ })).toContainText(
    money("1 000,00 Kč"),
  );
  await expect(table.getByRole("row", { name: /Neuhrazené zálohy/ })).toContainText(
    money("10 000,00 Kč"),
  );
  await expect(page.getByTestId("summary-overdue")).toContainText(money("1 000,00 Kč"));
  await page.getByRole("link", { name: "Zobrazit faktury po splatnosti" }).click();
  await expect(page).toHaveURL(/\/faktury\?stav=po-splatnosti$/);
});

test("[REP-004] export každého přehledu jde stáhnout", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL);
  const year = calendarDateInPrague(new Date()).slice(0, 4);
  const tabs = [
    "fakturace",
    "uhrady",
    "pohledavky",
    "zakaznici",
    "polozky",
    "meny",
    "limity",
    "predpoved",
  ];
  for (const tab of tabs) {
    await openReports(page, baseURL, `?zalozka=${tab}`);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Stáhnout CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`statistiky-${tab}-${year}-01-01-${year}-12-31.csv`);
  }
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Stáhnout Excel" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`statistiky-predpoved-${year}-01-01-${year}-12-31.xlsx`);
  const csv = await page.request.post(`${baseURL}/prehledy/export`, {
    headers: { origin: baseURL },
    form: { zalozka: "fakturace", format: "csv" },
  });
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body.startsWith("﻿")).toBe(true);
  expect(body).toContain("Celkem;1000,00;0,00");
});

async function invitedAccount(browser: Browser, url: string, baseURL: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Pokračovat k registraci" }).click();
  await expect(page).toHaveURL(/\/registrace$/);
  await page.getByLabel("Jméno").fill("Eva Dvořáková");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByText("eva@example.cz", { exact: true })).toBeVisible();
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);
  return { context, page };
}

test("[ARC-005] dva účty se stejným obdobím vidí každý své číslo", async ({
  page,
  browser,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await page.goto(`${baseURL}/administrace`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Pozvánky" }).click();
  await page.getByLabel("E-mail pozvaného").fill("eva@example.cz");
  await page.getByRole("button", { name: "Pozvat" }).click();
  const link = await page.getByLabel("Odkaz pozvánky").inputValue();

  const other = await invitedAccount(browser, link, baseURL);
  await cashInvoice(other.page, baseURL, "2500");

  await openReports(page, baseURL);
  await openReports(other.page, baseURL);
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("1 000,00 Kč"));
  await expect(other.page.getByTestId("summary-invoiced")).toContainText(money("2 500,00 Kč"));
  await page.reload();
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("1 000,00 Kč"));
  await other.context.close();
});

test("[ARC-005] platba se v Statistikách projeví hned po návratu ze stránky faktury", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  const invoiceUrl = await accountWithInvoice(page, baseURL);
  await openReports(page, baseURL);
  await expect(page.getByTestId("summary-income")).toContainText(money("0,00 Kč"));

  const nav = page.getByRole("navigation", { name: "Hlavní navigace" });
  await nav.getByRole("link", { name: "Faktury" }).click();
  await expect(page.getByRole("heading", { name: "Faktury", level: 1 })).toBeVisible();
  await page.goto(invoiceUrl);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-row")).toHaveCount(1);

  await nav.getByRole("link", { name: "Statistiky" }).click();
  await expect(page.getByTestId("summary-income")).toContainText(money("1 000,00 Kč"));
  await expect(page.getByTestId("summary-outstanding")).toContainText(money("0,00 Kč"));
  await page.goBack();
  await page.goForward();
  await expect(page.getByTestId("summary-income")).toContainText(money("1 000,00 Kč"));
});

test("[UI-008] záložky a filtr jdou ovládat klávesnicí a graf má tabulku hodnot", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL);
  await openReports(page, baseURL);
  await reportTabs(page).getByRole("link", { name: "Úhrady" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/zalozka=uhrady/);
  await expect(page.getByRole("heading", { name: "Úhrady", level: 2 })).toBeVisible();

  const filter = page.getByRole("form", { name: "Filtr statistik" });
  await filter.getByRole("combobox", { name: "Měna", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(filter.getByRole("combobox", { name: "Měna", exact: true })).toHaveValue("CZK");
  await filter.getByRole("button", { name: "Použít" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/mena=CZK/);
  await page.waitForLoadState("networkidle");

  const values = page.locator("summary", { hasText: "Tabulka hodnot" }).first();
  await values.focus();
  await page.keyboard.press("Enter");
  const table = page.getByRole("table", { name: "Úhrady v čase" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Vybrané období" })).toBeVisible();
});

test("[UI-009] účet bez dokladů vidí prázdný stav s akcí", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openReports(page, baseURL);
  await expect(
    page.getByRole("heading", { name: "Zatím nemáte žádné vystavené faktury" }),
  ).toBeVisible();
  await expect(page.getByRole("form", { name: "Filtr statistik" })).toHaveCount(0);
  await page.getByRole("link", { name: "Nová faktura" }).click();
  await expect(page).toHaveURL(/\/faktury\//);
});

test("statistiky po přepnutí na EUR neukazují CZK a nesčítají měny", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL);
  await openReports(page, baseURL);
  const filter = page.getByRole("form", { name: "Filtr statistik" });
  await filter.getByRole("combobox", { name: "Měna", exact: true }).selectOption("EUR");
  await filter.getByRole("button", { name: "Použít" }).click();
  await expect(page).toHaveURL(/mena=EUR/);
  const summary = page.getByRole("region", { name: "Souhrn" });
  await expect(page.getByTestId("summary-invoiced")).toContainText(money("0,00 €"));
  await expect(summary).not.toContainText("Kč");
  await expect(page.getByTestId("report-table")).not.toContainText("Kč");
});
