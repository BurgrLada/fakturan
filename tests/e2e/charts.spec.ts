import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { accountWithInvoice, openReports } from "./report-helpers";

test.setTimeout(120_000);

// Every chart kind of the Chart wrapper, on the tab that draws it.
const CHARTS: [tab: string, label: string][] = [
  ["fakturace", "Fakturace v čase"],
  ["fakturace", "Kumulativní fakturace"],
  ["uhrady", "Úhrady v čase"],
  ["uhrady", "Intenzita úhrad"],
  ["pohledavky", "Pohledávky podle stáří"],
  ["zakaznici", "Podíl zákazníků na fakturaci"],
  ["meny", "Podíl měn na fakturaci v Kč"],
  ["predpoved", "Očekávané příjmy po měsících"],
];

// Without a DSN the monitoring tunnel answers 404 on every page; that is not the chart's doing.
const MONITORING = "/api/monitoring";

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

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

async function chartColors(page: Page, label: string) {
  const chart = page.getByRole("img", { name: label });
  await expect(chart).toBeVisible();
  return chart.evaluate((svg) =>
    [...svg.querySelectorAll("path, rect, line")]
      .flatMap((node) => [getComputedStyle(node).fill, getComputedStyle(node).stroke])
      .filter((color) => color && color !== "none" && color !== "rgba(0, 0, 0, 0)"),
  );
}

test("[UI-005] graf je čitelný ve světlém i tmavém režimu bez chyby v konzoli", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await page.emulateMedia({ colorScheme: "light" });
  await accountWithInvoice(page, baseURL);
  const problems = watchConsole(page);

  const light = new Map<string, string[]>();
  for (const [tab, label] of CHARTS) {
    await openReports(page, baseURL, `?zalozka=${tab}`);
    await page.waitForLoadState("networkidle");
    expect(await isDark(page)).toBe(false);
    light.set(label, await chartColors(page, label));
  }

  await page.emulateMedia({ colorScheme: "dark" });
  for (const [tab, label] of CHARTS) {
    await openReports(page, baseURL, `?zalozka=${tab}`);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => isDark(page)).toBe(true);
    const dark = await chartColors(page, label);
    expect(dark.length, label).toBeGreaterThan(0);
    expect(dark, label).not.toEqual(light.get(label));
  }
  expect(
    problems.filter((text) =>
      /hydrat|Content Security Policy|Refused to|did not match/i.test(text),
    ),
  ).toEqual([]);
  expect(problems).toEqual([]);
});

test("[UI-007] na šířce 390 px stránka nepřetéká", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await accountWithInvoice(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  const problems = watchConsole(page);
  for (const tab of [
    "fakturace",
    "uhrady",
    "pohledavky",
    "zakaznici",
    "polozky",
    "meny",
    "limity",
    "predpoved",
  ]) {
    await openReports(page, baseURL, `?zalozka=${tab}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, tab).toBeLessThanOrEqual(0);
  }
  expect(problems).toEqual([]);
});
