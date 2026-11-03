import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { calendarDateInPrague } from "@/lib/number-format";
import type { QueryWidgetConfig } from "@/lib/widget-config";
import { expect, test } from "./fixtures";
import { addCustomer, addSupplier, CUSTOMER, PASSWORD, register } from "./invoice-helpers";
import { accountWithInvoice, cashInvoice, money, openReports } from "./report-helpers";

test.setTimeout(120_000);

// Without a DSN the monitoring tunnel answers 404 on every page; that is not the page's doing.
const MONITORING = "/api/monitoring";

const year = () => calendarDateInPrague(new Date()).slice(0, 4);
const widget = (page: Page, title: string) =>
  page.getByRole("region", { name: title, exact: true });
const grid = (page: Page) => page.getByTestId("dashboard-grid");

function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (message.location().url.includes(MONITORING)) return;
    problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

function withDb<T>(dataDir: string, action: (sqlite: Database.Database) => T): T {
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  try {
    return action(sqlite);
  } finally {
    sqlite.close();
  }
}

function addWidgets(dataDir: string, configs: QueryWidgetConfig[], dashboardId?: string) {
  withDb(dataDir, (sqlite) => {
    const board = sqlite
      .prepare("SELECT id, user_id AS userId FROM dashboard WHERE is_default = 1")
      .get() as { id: string; userId: string };
    if (dashboardId) board.id = dashboardId;
    const insert = sqlite.prepare(
      `INSERT INTO dashboard_widget (id, dashboard_id, user_id, config, x, y, w, h, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, 6, 4, ?, ?)`,
    );
    configs.forEach((config, index) => {
      const now = Date.now();
      insert.run(
        randomUUID(),
        board.id,
        board.userId,
        JSON.stringify(config),
        40 + index * 4,
        now,
        now,
      );
    });
  });
}

const query = (title: string, over: Partial<QueryWidgetConfig>): QueryWidgetConfig => ({
  v: 1,
  kind: "query",
  title,
  color: "chart-2",
  format: "auto",
  source: "invoices",
  metric: "sum",
  measure: "invoiced",
  period: "this_year",
  display: "number",
  ...over,
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

test("[UI-009] nový účet vidí výchozí dashboard s prázdnými stavy a akcí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await expect(grid(page).getByTestId("widget")).toHaveCount(9);
  await expect(page.getByText("Dokončete nastavení")).toBeVisible();
  for (const title of [
    "Fakturováno letos",
    "Pohledávky",
    "Nejbližší splatnosti",
    "Top zákazníci",
  ]) {
    await expect(widget(page, title).getByTestId("widget-empty")).toBeVisible();
  }
  await expect(widget(page, "Nejbližší splatnosti")).toContainText(
    "Žádná faktura není po splatnosti ani se splatností do 3 dnů.",
  );
  await widget(page, "Fakturováno letos").getByRole("link", { name: "Nová faktura" }).click();
  await expect(page).toHaveURL(/\/faktury\//);
});

test("[DSH-005] globální filtr změní období i měnu a widget ukáže skutečné období", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await page.goto(baseURL);
  const invoiced = widget(page, "Fakturováno letos");
  await expect(invoiced.getByTestId("widget-value")).toHaveText(money("1 000,00 Kč"));
  await expect(invoiced.getByTestId("widget-range")).toHaveText(
    `1. 1. ${year()} – 31. 12. ${year()}`,
  );
  await expect(widget(page, "Pohledávky").getByTestId("widget-range")).toHaveText("K dnešku");

  const filter = page.getByRole("form", { name: "Filtr dashboardu" });
  await filter.getByRole("combobox", { name: "Období", exact: true }).selectOption("minuly-rok");
  await filter.getByRole("button", { name: "Použít" }).click();
  await expect(page).toHaveURL(/obdobi=minuly-rok/);
  const last = Number(year()) - 1;
  await expect(invoiced.getByTestId("widget-range")).toHaveText(`1. 1. ${last} – 31. 12. ${last}`);
  await expect(invoiced.getByTestId("widget-empty")).toBeVisible();
  await expect(widget(page, "Pohledávky").getByTestId("widget-range")).toHaveText("K dnešku");

  await page.goto(`${baseURL}/?mena=EUR`);
  await expect(invoiced.getByTestId("widget-empty")).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Filtr dashboardu" }).getByRole("combobox", { name: "Měna" }),
  ).toHaveValue("EUR");
  await page.goto(`${baseURL}/?mena=CZK&obdobi=nesmysl`);
  await expect(invoiced.getByTestId("widget-value")).toHaveText(money("1 000,00 Kč"));

  await page.getByRole("link", { name: "Zrušit filtr" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
});

test("[DSH-014] všech devět zobrazení se vykreslí z jednoho výsledku", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  addWidgets(dataDir, [
    query("Z číslo", { display: "number" }),
    query("Z porovnání", { display: "number_compare", compare: "previous" }),
    query("Z tabulka", { display: "table", groupBy: "customer" }),
    query("Z sloupce", { display: "bar", groupBy: "month" }),
    query("Z skládané", { display: "stacked_bar", groupBy: "month", splitBy: "customer" }),
    query("Z čára", { display: "line", groupBy: "month" }),
    query("Z plocha", { display: "area", groupBy: "month", cumulative: true }),
    query("Z prstenec", { display: "donut", groupBy: "currency" }),
    query("Z heatmapa", { display: "heatmap", groupBy: "day", period: "last_30_days" }),
  ]);
  await page.goto(baseURL);
  await expect(widget(page, "Z číslo").getByTestId("widget-value")).toHaveText(
    money("1 000,00 Kč"),
  );
  await expect(widget(page, "Z porovnání").getByTestId("widget-change")).toHaveText(
    money("+1 000,00 Kč"),
  );
  const table = widget(page, "Z tabulka").getByRole("table", { name: "Z tabulka" });
  await expect(table).toContainText(CUSTOMER);
  await expect(table).toContainText(money("1 000,00 Kč"));
  for (const title of [
    "Z sloupce",
    "Z skládané",
    "Z čára",
    "Z plocha",
    "Z prstenec",
    "Z heatmapa",
  ]) {
    await expect(widget(page, title).getByRole("img", { name: title })).toBeVisible();
  }
});

test("[DSH-004] [UI-007] na šířce 390 px jsou widgety pod sebou a RGL se nenačte", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  const scripts: string[] = [];
  page.on("request", (request) => scripts.push(request.url()));
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, baseURL);
  await page.goto(baseURL);
  await page.waitForLoadState("networkidle");
  const cards = grid(page).getByTestId("widget");
  await expect(cards).toHaveCount(9);
  const boxes = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
    }),
  );
  for (const [index, box] of boxes.entries()) {
    expect(box.left).toBe(boxes[0]!.left);
    expect(box.width).toBe(boxes[0]!.width);
    if (index > 0) expect(box.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom);
  }
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  expect(scripts.filter((url) => /react-grid-layout/i.test(url))).toEqual([]);
  await expect(page.locator(".react-grid-layout")).toHaveCount(0);
});

test("[REM-009] výchozí Přehled ukazuje po splatnosti a blížící se splatnost", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await cashInvoice(page, baseURL, "1500");
  const due = (offset: string) =>
    withDb(dataDir, (sqlite) =>
      sqlite.prepare("UPDATE invoice SET due_date = date('now', ?)").run(offset),
    );
  const card = widget(page, "Nejbližší splatnosti");

  due("-2 days");
  await page.goto(baseURL);
  await expect(card.getByTestId("alerts-overdue")).toContainText(CUSTOMER);
  await expect(card.getByTestId("alerts-overdue")).toContainText(money("1 500,00 Kč"));

  due("+2 days");
  await page.goto(baseURL);
  await expect(card.getByTestId("alerts-due-soon")).toContainText(CUSTOMER);
  await expect(card.getByTestId("alerts-overdue")).toHaveCount(0);
});

test("[UI-005] Přehled nemá chybu v konzoli ve světlém ani tmavém režimu", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  const problems = watchConsole(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(baseURL);
    await page.waitForLoadState("networkidle");
    await expect(widget(page, "Tržby po měsících").getByRole("img")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      scheme === "dark",
    );
  }
  expect(problems).toEqual([]);
});

test("stejná čísla jako Statistiky pro fakturováno, příjmy a pohledávky", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  const paid = await accountWithInvoice(page, baseURL, "1000");
  await cashInvoice(page, baseURL, "1500");
  await page.goto(paid);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-row")).toHaveCount(1);
  await openReports(page, baseURL);
  const summary = async (metric: string) =>
    (await page.getByTestId(`summary-${metric}`).locator("p").nth(1).textContent())!;
  const expected = {
    "Fakturováno letos": await summary("invoiced"),
    "Uhrazeno letos": await summary("income"),
    Pohledávky: await summary("outstanding"),
  };
  expect(expected.Pohledávky).toMatch(money("1 500,00 Kč"));
  await page.goto(baseURL);
  for (const [title, value] of Object.entries(expected)) {
    await expect(widget(page, title).getByTestId("widget-value"), title).toHaveText(value);
  }
});

test("poškozený config v databázi shodí jen svůj widget", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  withDb(dataDir, (sqlite) =>
    sqlite
      .prepare(
        "UPDATE dashboard_widget SET config = '{rozbito' WHERE json_extract(config, '$.title') = 'Top zákazníci'",
      )
      .run(),
  );
  const days = query("Denní koše", { display: "heatmap", groupBy: "day", period: "last_30_days" });
  addWidgets(dataDir, [days]);
  const range = `obdobi=vlastni&od=${Number(year()) - 3}-01-01&do=${year()}-12-31`;
  await page.goto(`${baseURL}/?${range}`);
  await expect(page.getByRole("heading", { name: "Přehled", level: 1 })).toBeVisible();
  await expect(grid(page).getByTestId("widget-error")).toHaveCount(1);
  await expect(widget(page, "Fakturováno letos").getByTestId("widget-value")).toBeVisible();
  await expect(widget(page, "Denní koše")).toContainText("Období může mít nejvýš 400 košů");
  await expect(grid(page).getByTestId("widget")).toHaveCount(10);
  await expect(
    widget(page, "Denní koše").getByRole("link", { name: "Zrušit filtr" }),
  ).toHaveAttribute("href", "/");

  const second = randomUUID();
  withDb(dataDir, (sqlite) =>
    sqlite
      .prepare(
        `INSERT INTO dashboard (id, user_id, name, is_default, position, revision, created_at, updated_at)
         SELECT ?, user_id, 'Druhý', 0, 1, 1, created_at, updated_at FROM dashboard WHERE is_default = 1`,
      )
      .run(second),
  );
  addWidgets(dataDir, [days], second);
  await page.goto(`${baseURL}/?dashboard=${second}&${range}`);
  await expect(
    widget(page, "Denní koše").getByRole("link", { name: "Zrušit filtr" }),
  ).toHaveAttribute("href", `/?dashboard=${second}`);
});

test("cachedWidget je oddělený podle účtu", async ({ page, browser, freshApp }) => {
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

  await page.goto(baseURL);
  await other.page.goto(baseURL);
  await expect(widget(page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("1 000,00 Kč"),
  );
  await expect(widget(other.page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("2 500,00 Kč"),
  );
  await page.reload();
  await expect(widget(page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("1 000,00 Kč"),
  );
  await other.context.close();
});
