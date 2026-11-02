import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { chooseCustomer, fillLine, issue, openForm, ready, settled } from "./invoice-helpers";

// One issued cash invoice dated today; returns its detail URL.
export async function cashInvoice(page: Page, baseURL: string, price = "1000"): Promise<string> {
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", price);
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");
  return page.url();
}

export async function accountWithInvoice(page: Page, baseURL: string, price = "1000") {
  await ready(page, baseURL);
  return cashInvoice(page, baseURL, price);
}

export const money = (text: string) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s"));

export async function openReports(page: Page, baseURL: string, query = "") {
  await page.goto(`${baseURL}/prehledy${query}`);
  await expect(page.getByRole("heading", { name: "Statistiky", level: 1 })).toBeVisible();
}

export const reportTabs = (page: Page) => page.getByRole("navigation", { name: "Přehledy" });
