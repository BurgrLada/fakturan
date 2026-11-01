import type { Page } from "@playwright/test";
import { pdfText } from "../helpers/pdf";
import { expect } from "./fixtures";

export const PASSWORD = "správné-kůň-baterie-sponka";
export const CUSTOMER = "Alfa s.r.o.";

export async function register(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

export async function addSupplier(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/nastaveni/dodavatel`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Jméno nebo firma").fill("Jan Novák");
  await page.getByLabel("Ulice a číslo").fill("Dlouhá 1");
  await page.getByLabel("Město").fill("Praha");
  await page.getByLabel("PSČ").fill("110 00");
  await page.getByLabel("IČO").fill("27082440");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByText("Uloženo.").first()).toBeVisible();
}

export async function addCustomer(page: Page, baseURL: string, name = CUSTOMER, email = "") {
  await page.goto(`${baseURL}/zakaznici/novy`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název nebo jméno").fill(name);
  if (email) await page.getByLabel("E-mail pro fakturaci").fill(email);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("heading", { name: "Karta zákazníka" })).toBeVisible();
}

export async function addCatalogItem(page: Page, baseURL: string, name: string, currency = "CZK") {
  await page.goto(`${baseURL}/cenik/novy`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název").fill(name);
  await page.getByLabel("Jednotka").selectOption("hod.");
  await page.getByLabel("Cena za jednotku").fill("1500");
  await page.getByLabel("Měna").selectOption(currency);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page).toHaveURL(/\/cenik\/(?!novy)[\w-]+$/);
}

export async function addAccount(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/nastaveni/ucty`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název účtu").fill("Hlavní účet");
  await page.getByLabel("Číslo účtu (i s předčíslím)").fill("2000145399");
  await page.getByLabel("Kód banky").fill("0800");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("Účet je uložený.")).toBeVisible();
}

export async function openForm(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/faktury/nova`);
  await page.waitForLoadState("networkidle");
}

export async function chooseCustomer(page: Page, name = CUSTOMER) {
  await page.getByRole("combobox", { name: "Zákazník" }).fill(name.slice(0, 3));
  await page.getByRole("option", { name }).click();
}

export const saved = (page: Page) => expect(page.getByTestId("save-status")).toHaveText("Uloženo");

// Waits past the debounce, because "Uloženo" may still describe the previous write.
export async function settled(page: Page) {
  await expect(page.getByTestId("save-status")).toHaveText(/Čeká|Ukládám|Uloženo/);
  await page.waitForTimeout(100);
  await saved(page);
}

export async function fillLine(page: Page, index: number, name: string, price: string) {
  await page.getByRole("combobox", { name: "Název položky" }).nth(index).fill(name);
  await page.getByLabel("Cena za jednotku").nth(index).fill(price);
}

export async function issueWithOffer(page: Page) {
  await page.getByRole("button", { name: "Vystavit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/?]+\?vystaveno=1$/);
}

// Leaves the plain detail URL, which tests extend with /pdf or /upravit.
export async function issue(page: Page) {
  await issueWithOffer(page);
  await page.goto(page.url().split("?")[0]);
}

export async function issuedPdf(page: Page) {
  const response = await page.request.get(`${page.url().split("?")[0]}/pdf`);
  expect(response.status()).toBe(200);
  return (await pdfText(await response.body())).join("\n");
}

export async function draftPdf(page: Page) {
  const src = await page.getByTitle("Náhled faktury").getAttribute("src");
  const response = await page.request.get(new URL(src!, page.url()).href);
  expect(response.status()).toBe(200);
  return (await pdfText(await response.body())).join("\n");
}

export async function invite(page: Page, email: string, baseURL: string): Promise<string> {
  await page.goto(`${baseURL}/administrace`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Pozvánky" }).click();
  await page.getByLabel("E-mail pozvaného").fill(email);
  await page.getByRole("button", { name: "Pozvat" }).click();
  const link = page.getByLabel("Odkaz pozvánky");
  await expect(link).toBeVisible();
  return link.inputValue();
}

export async function ready(page: Page, baseURL: string) {
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);
}

export async function cashInvoice(page: Page) {
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "1000");
}
