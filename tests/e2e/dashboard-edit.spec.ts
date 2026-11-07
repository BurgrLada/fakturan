import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { calendarDateInPrague } from "@/lib/number-format";
import { expect, test } from "./fixtures";
import { watchGridChunk } from "./grid-chunk";
import { register } from "./invoice-helpers";
import { accountWithInvoice, cashInvoice, money } from "./report-helpers";

test.setTimeout(120_000);

const overviewCard = (page: Page, title: string) =>
  page.getByTestId("dashboard-grid").getByRole("region", { name: title, exact: true });
// Next keeps the previous route hidden in the DOM, so only visible cards count.
const editCards = (page: Page) => page.getByTestId("edit-widget").filter({ visible: true });
const editCard = (page: Page, title: string) =>
  editCards(page).filter({ has: page.getByRole("heading", { name: title }) });
const VALUE_LABEL = '[data-ts-key^="value-label:"]';
const preview = (page: Page) => page.getByTestId("widget-preview");
const announcement = (page: Page) => page.getByTestId("layout-announcement");

async function openEditor(page: Page, baseURL: string) {
  await page.goto(baseURL);
  await page.getByRole("link", { name: "Upravit dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Úpravy dashboardu", level: 1 })).toBeVisible();
  await expect(editCards(page).first()).toBeVisible();
}

async function openConfigurator(page: Page, title: string) {
  await page.getByRole("link", { name: `Nastavit widget ${title}` }).click();
  await expect(page.getByRole("heading", { name: "Nastavení widgetu" })).toBeVisible();
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number) {
  await handle.hover();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(x + (dx * step) / 10, y + (dy * step) / 10);
  }
  await page.mouse.up();
}

async function gridStep(page: Page) {
  const width = (await page.getByTestId("grid-editor").boundingBox())!.width;
  return { column: (width - 16 * 11) / 12 + 16, row: 72 + 16 };
}

function previewRequests(page: Page, delayed: (body: string) => boolean, ms: number) {
  return page.route("**/dashboardy/**", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (request.method() === "POST" && request.headers()["next-action"] && delayed(body)) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}

test("[DSH-001] widget jde přetáhnout, zvětšit a po obnovení zůstane na místě", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const card = editCard(page, "Průměrná doba úhrady");
  await expect(card).toHaveAttribute("data-box", "8,2,3,2");
  const { column, row } = await gridStep(page);

  await dragBy(page, card.locator(".widget-drag"), column, 0);
  await expect(card).toHaveAttribute("data-box", "9,2,3,2");
  await dragBy(page, card.locator(".react-resizable-handle"), 0, row);
  await expect(card).toHaveAttribute("data-box", "9,2,3,3");
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");

  let warning = "";
  page.once("dialog", (dialog) => {
    warning = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("link", { name: "Zpět na přehled" }).click();
  await expect.poll(() => warning).toBe("Rozložení není uložené. Opravdu odejít bez uložení?");
  await expect(page).toHaveURL(/\/upravit$/);
  let asked = 0;
  page.on("dialog", (dialog) => {
    asked += 1;
    void dialog.dismiss();
  });
  const manage = page.getByRole("group", { name: "Správa dashboardu" });
  await manage.getByRole("button", { name: "Duplikovat" }).click();
  await expect.poll(() => asked).toBe(1);
  await manage.getByRole("button", { name: "Nový dashboard" }).click();
  await page.getByLabel("Název dashboardu").fill("Nechtěný");
  await page.getByRole("button", { name: "Uložit", exact: true }).click();
  await expect.poll(() => asked).toBe(2);
  await expect(page).toHaveURL(/\/upravit$/);

  await page.getByRole("button", { name: "Uložit rozložení" }).click();
  await expect(page.getByText("Rozložení je uložené.")).toBeVisible();
  await page.reload();
  await expect(editCard(page, "Průměrná doba úhrady")).toHaveAttribute("data-box", "9,2,3,3");

  await page.getByRole("link", { name: "Zpět na přehled" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  const style = await overviewCard(page, "Průměrná doba úhrady").getAttribute("style");
  expect(style).toContain("--x: 10;");
  expect(style).toContain("--h: 3;");
  await expect(page.getByRole("navigation", { name: "Dashboardy" })).toHaveCount(0);
});

test("[DSH-001] Zpět v prohlížeči s neuloženými změnami se zeptá a Zrušit nechá editor otevřený", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const card = editCard(page, "Průměrná doba úhrady");
  const { column } = await gridStep(page);
  await dragBy(page, card.locator(".widget-drag"), column, 0);
  await expect(card).toHaveAttribute("data-box", "9,2,3,2");
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");

  let warning = "";
  page.once("dialog", (dialog) => {
    warning = dialog.message();
    void dialog.dismiss();
  });
  await page.evaluate(() => history.back());
  await expect.poll(() => warning).toBe("Rozložení není uložené. Opravdu odejít bez uložení?");
  await expect(page).toHaveURL(/\/upravit$/);
  await expect(page.getByRole("heading", { name: "Úpravy dashboardu", level: 1 })).toBeVisible();
  await expect(card).toHaveAttribute("data-box", "9,2,3,2");
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");

  // The guard works again after a cancel, also once the grace of the first cleanup is over.
  await page.waitForTimeout(1_100);
  let again = "";
  page.once("dialog", (dialog) => {
    again = dialog.message();
    void dialog.accept();
  });
  await page.evaluate(() => history.back());
  await expect.poll(() => again).toBe("Rozložení není uložené. Opravdu odejít bez uložení?");
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByTestId("dashboard-grid")).toBeVisible();
});

test("[DSH-001] Dopředu do editoru se změnami a Zrušit nechá adresu i obsah v souladu", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const editorUrl = page.url();
  const card = editCard(page, "Průměrná doba úhrady");
  const { column } = await gridStep(page);
  await dragBy(page, card.locator(".widget-drag"), column, 0);
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");

  // Leave by the link (confirmed), then come back with Back: the editor keeps its changes and the
  // overview stays ahead of it in the history.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "Zpět na přehled" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole("heading", { name: "Úpravy dashboardu", level: 1 })).toBeVisible();
  if ((await page.getByTestId("layout-state").textContent()) !== "Rozložení má neuložené změny.") {
    await dragBy(page, card.locator(".widget-drag"), column, 0);
  }
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");

  let warning = "";
  page.once("dialog", (dialog) => {
    warning = dialog.message();
    void dialog.dismiss();
  });
  await page.evaluate(() => history.forward());
  await expect.poll(() => warning).toBe("Rozložení není uložené. Opravdu odejít bez uložení?");
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole("heading", { name: "Úpravy dashboardu", level: 1 })).toBeVisible();
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");
});

test("[DSH-001] po odchodu z editoru funguje Zpět na jiné stránce normálně", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const card = editCard(page, "Průměrná doba úhrady");
  const { column } = await gridStep(page);
  await dragBy(page, card.locator(".widget-drag"), column, 0);
  await expect(page.getByTestId("layout-state")).toHaveText("Rozložení má neuložené změny.");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "Zpět na přehled" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);

  let asked = 0;
  page.on("dialog", (dialog) => {
    asked += 1;
    void dialog.dismiss();
  });
  await page.getByRole("link", { name: "Faktury", exact: true }).first().click();
  await expect(page).toHaveURL(/\/faktury$/);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByTestId("dashboard-grid")).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/\/faktury$/);
  expect(asked).toBe(0);
});

test("[UI-008] rozložení jde změnit jen klávesnicí a změna se oznámí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const title = "Průměrná doba úhrady";
  const right = page.getByRole("button", { name: `Posunout vpravo: ${title}` });
  await right.focus();
  await page.keyboard.press("Enter");
  await expect(announcement(page)).toHaveText(
    `${title}: sloupec 10, řádek 3, šířka 3 z 12, výška 2.`,
  );
  await expect(right).toBeFocused();
  await expect(editCard(page, title)).toHaveAttribute("data-box", "9,2,3,2");

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: `Rozšířit: ${title}` })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(announcement(page)).toHaveText(
    `${title}: sloupec 9, řádek 3, šířka 4 z 12, výška 2.`,
  );

  const up = page.getByRole("button", { name: "Posunout nahoru: Fakturováno letos" });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect(announcement(page)).toHaveText("Fakturováno letos: tímto směrem už to nejde.");

  await page.getByRole("button", { name: "Uložit rozložení" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Rozložení je uložené.")).toBeVisible();
  await page.reload();
  await expect(editCard(page, title)).toHaveAttribute("data-box", "8,2,4,2");
});

test("[DSH-002] druhý dashboard jde přejmenovat, duplikovat, nastavit výchozí a smazat", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const manage = page.getByRole("group", { name: "Správa dashboardu" });
  await expect(manage.getByText("Výchozí dashboard")).toBeVisible();
  await expect(manage.getByRole("button", { name: "Smazat dashboard" })).toHaveCount(0);

  await manage.getByRole("button", { name: "Nový dashboard" }).click();
  await page.getByLabel("Název dashboardu").fill("Obchod");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Obchod", { exact: true })).toBeVisible();
  await expect(editCards(page)).toHaveCount(1);

  await manage.getByRole("button", { name: "Přejmenovat" }).click();
  await expect(page.getByLabel("Název dashboardu")).toHaveValue("Obchod");
  await page.getByLabel("Název dashboardu").fill("Prodej");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Dashboard je přejmenovaný.")).toBeVisible();
  await expect(page.getByText("Prodej", { exact: true })).toBeVisible();
  const second = page.url();

  await manage.getByRole("button", { name: "Duplikovat" }).click();
  await expect(page.getByText("Prodej (kopie)", { exact: true })).toBeVisible();
  expect(page.url()).not.toBe(second);
  await manage.getByRole("button", { name: "Nastavit jako výchozí" }).click();
  await expect(page.getByText("Dashboard je teď výchozí.")).toBeVisible();
  await expect(manage.getByText("Výchozí dashboard")).toBeVisible();

  await page.goto(baseURL);
  const switcher = page.getByRole("navigation", { name: "Dashboardy" });
  await expect(switcher.getByRole("link")).toHaveText(["Přehled", "Prodej", "Prodej (kopie)"]);
  await expect(switcher.locator('[aria-current="page"]')).toHaveText("Prodej (kopie)");

  await page.getByRole("link", { name: "Upravit dashboard" }).click();
  await manage.getByRole("button", { name: "Smazat dashboard" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Smazat dashboard" }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(switcher.getByRole("link")).toHaveText(["Přehled", "Prodej"]);
  await expect(switcher.locator('[aria-current="page"]')).toHaveText("Přehled");
});

test("[DSH-016] název, barva, popisky a formát čísla se projeví", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await openEditor(page, baseURL);
  await openConfigurator(page, "Fakturováno letos");
  await page.getByLabel("Název").fill("Obrat letos");
  await page.getByLabel("Formát čísel").selectOption({ label: "V tisících" });
  await expect(preview(page).getByTestId("widget-value")).toHaveText(money("1 tis. Kč"));
  await page.getByRole("button", { name: "Uložit widget" }).click();
  await expect(page).toHaveURL(/\/upravit$/);

  await openConfigurator(page, "Tržby po měsících");
  await expect(preview(page).getByRole("img")).toBeVisible();
  await expect(preview(page).locator(VALUE_LABEL)).toHaveCount(0);
  await page.locator("label", { hasText: "Modrá" }).filter({ visible: true }).click();
  await expect(page.getByRole("radio", { name: "Modrá" })).toBeChecked();
  await page.getByLabel("Hodnoty přímo v grafu").check();
  await expect(preview(page).locator('svg [fill="var(--chart-4)"]').first()).toBeAttached();
  await expect(preview(page).locator(VALUE_LABEL, { hasText: money("1 000,00 Kč") })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Uložit widget" }).click();
  await expect(page).toHaveURL(/\/upravit$/);

  await page.goto(baseURL);
  await expect(overviewCard(page, "Obrat letos").getByTestId("widget-value")).toHaveText(
    money("1 tis. Kč"),
  );
  const chart = overviewCard(page, "Tržby po měsících").getByRole("img");
  await expect(chart.locator('[fill="var(--chart-4)"]').first()).toBeAttached();
  await expect(chart.locator(VALUE_LABEL, { hasText: money("1 000,00 Kč") })).toHaveCount(1);
  await expect(overviewCard(page, "Meziroční porovnání").locator(VALUE_LABEL)).toHaveCount(0);
});

test("[DSH-017] změna metriky se ukáže v náhledu bez uložení", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await cashInvoice(page, baseURL, "1500");
  await openEditor(page, baseURL);
  await openConfigurator(page, "Fakturováno letos");
  await expect(preview(page).getByTestId("widget-value")).toHaveText(money("2 500,00 Kč"));
  await page.getByLabel("Výpočet").selectOption({ label: "Počet" });
  await expect(preview(page).getByTestId("widget-value")).toHaveText("2");
  await page.getByLabel("Výpočet").selectOption({ label: "Průměr" });
  await expect(preview(page).getByTestId("widget-value")).toHaveText(money("1 250,00 Kč"));

  await page.getByRole("link", { name: "Zrušit" }).click();
  await page.goto(baseURL);
  await expect(overviewCard(page, "Fakturováno letos").getByTestId("widget-value")).toHaveText(
    money("2 500,00 Kč"),
  );
});

test("[DSH-017] pozdní odpověď staršího náhledu se zahodí", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL, "1000");
  await cashInvoice(page, baseURL, "1500");
  await openEditor(page, baseURL);
  await openConfigurator(page, "Fakturováno letos");
  await expect(preview(page).getByTestId("widget-value")).toHaveText(money("2 500,00 Kč"));
  let delayed = 0;
  await previewRequests(
    page,
    (body) => {
      const late = body.includes('"metric":"count"');
      if (late) delayed += 1;
      return late;
    },
    2_500,
  );

  await page.getByLabel("Výpočet").selectOption({ label: "Počet" });
  await expect.poll(() => delayed).toBe(1);
  await page.getByLabel("Výpočet").selectOption({ label: "Průměr" });
  await expect(preview(page).getByTestId("widget-value")).toHaveText(money("1 250,00 Kč"));
  await page.waitForTimeout(3_000);
  await expect(preview(page).getByTestId("widget-value")).toHaveText(money("1 250,00 Kč"));
  await expect(preview(page)).toHaveAttribute("aria-busy", "false");
});

test("konfigurátor nenabídne neplatnou kombinaci", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  await openConfigurator(page, "Pohledávky");
  const options = (label: string) =>
    page.getByRole("combobox", { name: label, exact: true }).locator("option").allTextContents();
  await expect(page.getByRole("combobox", { name: "Období", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Porovnat s", exact: true })).toHaveCount(0);
  expect(await options("Zobrazení")).not.toContain("Číslo s porovnáním");
  expect(await options("Zobrazení")).not.toContain("Heatmapa");

  await page
    .getByRole("combobox", { name: "Co se počítá", exact: true })
    .selectOption({ label: "Fakturováno" });
  await expect(page.getByRole("combobox", { name: "Období", exact: true })).toHaveValue(
    "this_year",
  );
  await page
    .getByRole("combobox", { name: "Zobrazení", exact: true })
    .selectOption({ label: "Sloupce" });
  await expect(page.getByRole("combobox", { name: "Seskupit podle", exact: true })).toHaveValue(
    "month",
  );

  await expect(page.getByRole("combobox", { name: "Formát čísel" })).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Seskupit podle", exact: true })
    .selectOption({ label: "Dnů" });
  await page
    .getByRole("combobox", { name: "Období", exact: true })
    .selectOption({ label: "Vlastní podle dat" });
  const today = calendarDateInPrague(new Date());
  await expect(page.getByLabel("Od", { exact: true }).filter({ visible: true })).toHaveValue(
    `${today.slice(0, 4)}-01-01`,
  );
  await expect(page.getByLabel("Do", { exact: true }).filter({ visible: true })).toHaveValue(today);
  await page.getByLabel("Od", { exact: true }).filter({ visible: true }).fill("2020-01-01");
  await expect(page.getByRole("combobox", { name: "Seskupit podle", exact: true })).toHaveValue(
    "month",
  );
  await expect(page.getByTestId("preview-invalid")).toHaveCount(0);

  await page
    .getByRole("combobox", { name: "Zobrazení", exact: true })
    .selectOption({ label: "Tabulka" });
  await expect(page.getByRole("combobox", { name: "Formát čísel" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Seskupit podle", exact: true })
    .selectOption({ label: "Zákazníků" });
  await page.getByLabel("Jen nejvyšší řádky").check();
  const top = page.getByLabel("Počet nejvyšších řádků");
  await expect(top).toHaveValue("5");
  await top.press("End");
  await top.press("Backspace");
  await expect(top).toHaveValue("");
  await top.pressSequentially("12");
  await expect(top).toHaveValue("12");
  await top.blur();
  await expect(top).toHaveValue("12");

  await page
    .getByRole("combobox", { name: "Zdroj dat", exact: true })
    .selectOption({ label: "Zákazníci" });
  expect(await options("Výpočet")).toEqual(["Počet"]);
  await expect(page.getByRole("combobox", { name: "Co se počítá", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Měna", exact: true })).toHaveCount(0);
  expect(await options("Seskupit podle")).not.toContain("Zákazníků");
  await expect(page.getByTestId("preview-invalid")).toHaveCount(0);
  await expect(preview(page).getByTestId("widget-body")).toBeVisible();
});

test("[REM-009] karta REM-009 nemá v úpravách akci odebrat", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  await openEditor(page, baseURL);
  const pinned = editCard(page, "Nejbližší splatnosti");
  await expect(pinned.getByRole("button", { name: /^Odebrat/ })).toHaveCount(0);
  await expect(pinned).toContainText("Upozornění na splatnost zůstává na každém dashboardu.");
  await expect(
    page.getByRole("button", { name: "Posunout dolů: Nejbližší splatnosti" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Odebrat widget Po splatnosti" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Odebrat" }).click();
  await expect(page.getByText("Widget Po splatnosti je odebraný.")).toBeVisible();
  await expect(editCards(page)).toHaveCount(8);

  await page.getByRole("link", { name: "Přidat widget" }).click();
  const gallery = page.getByTestId("widget-gallery");
  await expect(gallery.getByRole("listitem")).toHaveCount(22);
  await expect(
    gallery.getByRole("link", { name: "Přidat widget Nejbližší splatnosti" }),
  ).toHaveCount(0);
  await expect(gallery).toContainText("Už je na dashboardu");
  await gallery.getByRole("link", { name: "Přidat widget Stárnutí pohledávek" }).click();
  await page.getByRole("button", { name: "Přidat na dashboard" }).click();
  await expect(page).toHaveURL(/\/upravit$/);
  await expect(editCards(page)).toHaveCount(9);

  const sqlite = new Database(join(dataDir, "fakturan.db"));
  try {
    const rows = sqlite
      .prepare("SELECT config FROM dashboard_widget WHERE config LIKE '%due_alerts%'")
      .all();
    expect(rows).toHaveLength(1);
  } finally {
    sqlite.close();
  }
});

test("[UI-007] na telefonu chybí vstup do úprav a Přehled jde číst", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  const gridLoaded = watchGridChunk(page);
  const gridStyles = watchGridChunk(page, "stylesheet");
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, baseURL);
  await page.goto(baseURL);
  await expect(page.getByTestId("dashboard-grid").getByTestId("widget")).toHaveCount(9);
  await expect(overviewCard(page, "Nejbližší splatnosti")).toBeVisible();
  await expect(page.getByRole("link", { name: "Upravit dashboard" })).toBeHidden();

  const href = await page.locator('a[href$="/upravit"]').getAttribute("href");
  await page.goto(`${baseURL}${href}`);
  await expect(page.getByTestId("edit-narrow")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".react-grid-layout")).toHaveCount(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  expect(await gridLoaded()).toBe(false);
  expect(await gridStyles()).toBe(false);

  // The same check finds the library once the editor is wide enough to load it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".react-grid-layout")).toBeVisible();
  await expect.poll(gridLoaded).toBe(true);
  await expect.poll(gridStyles).toBe(true);
});
