import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  addAccount,
  addCustomer,
  addSupplier,
  chooseCurrency,
  chooseCustomer,
  fillLine,
  issue,
  issuedPdf,
  openForm,
  ready,
  register,
  settled,
} from "./invoice-helpers";

const rate = (page: Page) => page.getByLabel("Kurz k CZK");
const source = (page: Page) => page.getByTestId("rate-source");
const notes = (page: Page) => page.getByTestId("rate-notes");

async function foreignCustomer(page: Page, baseURL: string, name: string, dic: string) {
  await page.goto(`${baseURL}/zakaznici/novy`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název nebo jméno").fill(name);
  await page.getByLabel("Stát").fill("Německo");
  await page.getByLabel("DIČ").fill(dic);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("heading", { name: "Karta zákazníka" })).toBeVisible();
}

async function identified(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/nastaveni/dodavatel`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Jsem identifikovaná osoba k DPH").check();
  await page.getByLabel("DIČ").fill("CZ27082440");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByText("Uloženo.").first()).toBeVisible();
}

async function eurAccount(page: Page, baseURL: string, currency = "EUR", swift = "") {
  await page.goto(`${baseURL}/nastaveni/ucty`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název účtu").fill(`Účet ${currency}`);
  await page.getByLabel("Měna").selectOption(currency);
  await page.getByLabel("Číslo účtu (i s předčíslím)").fill("2000145399");
  await page.getByLabel("Kód banky").fill("0800");
  if (swift) await page.getByLabel("BIC").fill(swift);
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("Účet je uložený.")).toBeVisible();
}

async function eurCashDraft(page: Page, baseURL: string) {
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "100");
  await page.getByLabel("Datum vystavení").fill("2026-10-20");
  await chooseCurrency(page, "EUR");
}

test("[FOR-001] přepínač odkryje měnu, kurz a doložku", async ({ page, freshApp }) => {
  await ready(page, freshApp.baseURL);
  await openForm(page, freshApp.baseURL);
  await expect(page.getByLabel("Měna")).toHaveCount(0);
  await expect(page.getByLabel("Doložka na faktuře")).toHaveCount(0);

  await page.getByLabel("Zahraniční faktura").check();
  await expect(page.getByLabel("Doložka na faktuře")).toBeVisible();
  await expect(page.getByText("ověřte s daňovým poradcem")).toBeVisible();
  await expect(rate(page)).toHaveCount(0);

  await page.getByLabel("Měna").selectOption("EUR");
  await expect(rate(page)).toBeVisible();

  await page.getByLabel("Zahraniční faktura").uncheck();
  await expect(page.getByLabel("Měna")).toHaveCount(0);
});

test("[FOR-001] zákazník z Německa zapne přepínač, zákazník z Česka ne", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await foreignCustomer(page, baseURL, "Müller GmbH", "DE123456789");

  await openForm(page, baseURL);
  await chooseCustomer(page);
  await expect(page.getByLabel("Zahraniční faktura")).not.toBeChecked();

  await openForm(page, baseURL);
  await chooseCustomer(page, "Müller GmbH");
  await expect(page.getByLabel("Zahraniční faktura")).toBeChecked();
});

test("[FOR-006] identifikovaná osoba má doložku, PDF ji vytiskne a změna jazyka ji přeloží", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await identified(page, baseURL);
  await foreignCustomer(page, baseURL, "Müller GmbH", "DE123456789");

  await openForm(page, baseURL);
  await chooseCustomer(page, "Müller GmbH");
  const clause = page.getByLabel("Doložka na faktuře");
  await expect(clause).toHaveValue(/Daň odvede zákazník/);

  await page.getByLabel("Jazyk faktury").selectOption("en");
  await expect(clause).toHaveValue(/Reverse charge/);

  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Consulting", "100");
  await settled(page);
  await issue(page);
  const text = await issuedPdf(page);
  expect(text).toContain("Reverse charge");
  expect(text).toContain("DE123456789");
  expect(text).toContain("CZ27082440");
});

test("[FOR-003] [TST-012] změna data přenačte automatický kurz, ruční zůstane", async ({
  page,
  freshApp,
}) => {
  await ready(page, freshApp.baseURL);
  await eurCashDraft(page, freshApp.baseURL);
  await expect(rate(page)).toHaveValue("24,2");
  await expect(source(page)).toContainText("Kurz ČNB k");

  await page.getByLabel("Datum vystavení").fill("2026-10-21");
  await expect(rate(page)).toHaveValue("24,21");

  await rate(page).fill("25,5");
  await expect(source(page)).toHaveText("Ručně zadaný kurz");
  await page.getByLabel("Datum vystavení").fill("2026-10-20");
  await page.waitForTimeout(600);
  await expect(rate(page)).toHaveValue("25,5");

  await page.getByRole("button", { name: "Použít kurz ČNB" }).click();
  await expect(rate(page)).toHaveValue("24,2");
  await expect(source(page)).toContainText("Kurz ČNB");
});

test("[FOR-003] změna EUR na USD smaže i ruční kurz a načte nový", async ({ page, freshApp }) => {
  await ready(page, freshApp.baseURL);
  await eurCashDraft(page, freshApp.baseURL);
  await rate(page).fill("25,5");
  await page.getByLabel("Měna").selectOption("USD");
  await expect(rate(page)).toHaveValue("22,311");
  await expect(source(page)).toContainText("Kurz ČNB");
});

test("[FOR-004] ČNB dole: formulář ukáže poslední známý kurz s upozorněním a jde vystavit", async ({
  page,
  freshApp,
}) => {
  await ready(page, freshApp.baseURL);
  await eurCashDraft(page, freshApp.baseURL);
  await expect(rate(page)).toHaveValue("24,2");
  await settled(page);

  freshApp.cnb.setAvailable(false);
  await page.getByLabel("Datum vystavení").fill("2026-10-27");
  await expect(source(page)).toContainText("Poslední známý kurz ČNB");
  await expect(notes(page)).toContainText("použit je poslední známý");
  await settled(page);

  await page.getByRole("button", { name: "Vystavit" }).click();
  await expect(page.getByTestId("issue-rate-note").first()).toContainText("poslední známý");
  await page.getByRole("alertdialog").getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/?]+\?vystaveno=1$/);
});

test.describe("ČNB nedostupná od začátku", () => {
  test.use({ cnbAvailable: false });

  test("[FOR-004] ČNB dole a prázdná tabulka: ruční kurz jde zadat a vystavit", async ({
    page,
    freshApp,
  }) => {
    await ready(page, freshApp.baseURL);
    await eurCashDraft(page, freshApp.baseURL);
    await page.waitForTimeout(600);
    await expect(rate(page)).toHaveValue("");
    await expect(rate(page)).toBeEditable();

    await rate(page).fill("24,5");
    await expect(notes(page)).toContainText("nešlo ověřit");
    await settled(page);
    await issue(page);
    expect(await issuedPdf(page)).toContain("100,00 €");
  });
});

test("[FOR-005] chybějící účet v USD formulář ukáže před vystavením", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await addAccount(page, baseURL);
  await openForm(page, baseURL);
  await expect(page.getByTestId("account-missing")).toHaveCount(0);
  await chooseCurrency(page, "USD");
  await expect(page.getByTestId("account-missing")).toContainText("Nemáte bankovní účet v USD");
});

test("[FOR-009] nastavený základ DUZP řídí načtený kurz", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await page.goto(`${baseURL}/nastaveni/vychozi`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Rozhodný den pro kurz").selectOption("taxable_date");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await eurCashDraft(page, baseURL);
  await expect(rate(page)).toHaveValue("24,2");
  await page.getByLabel("DUZP (nepovinné)").fill("2026-10-22");
  await expect(rate(page)).toHaveValue("24,22");
});

test("[FOR-010] pevný kurz je ve formuláři označený a odchylka nad 5 % ukáže upozornění", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await page.goto(`${baseURL}/nastaveni/vychozi`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Pevný kurz EUR").fill("27");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Uloženo.")).toBeVisible();

  await eurCashDraft(page, baseURL);
  await expect(rate(page)).toHaveValue("27");
  await expect(source(page)).toHaveText("Pevný kurz z nastavení");
  await expect(notes(page)).toContainText("liší o více než 5 %");
  await settled(page);

  await page.getByRole("button", { name: "Vystavit" }).click();
  await expect(page.getByTestId("issue-rate-note")).toContainText("liší o více než 5 %");
});

test("[QR-002] formulář konceptu v EUR bez IBAN řekne proč QR není", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await eurAccount(page, baseURL);
  await openForm(page, baseURL);
  await chooseCurrency(page, "EUR");
  await expect(page.getByTestId("form-qr-reason")).toContainText("u EUR navíc BIC");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await expect(page.getByTestId("form-qr-reason")).toHaveCount(0);
});

test("[CUS-008] tlačítko na detailu obnoví údaje zákazníka", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);
  const customerUrl = page.url();
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "1000");
  await settled(page);
  await issue(page);
  const detail = page.url();

  await page.goto(customerUrl);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název nebo jméno").fill("Alfa nová s.r.o.");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByText("Zákazník je uložený.")).toBeVisible();

  await page.goto(detail);
  await page.waitForLoadState("networkidle");
  expect(await issuedPdf(page)).not.toContain("Alfa nová");
  await page.getByRole("button", { name: "Načíst údaje zákazníka" }).click();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => issuedPdf(page)).toContain("Alfa nová");
});

test("[PAY-006] dialog platby v jiné měně předvyplní připsanou částku", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await eurCashDraft(page, baseURL);
  await expect(rate(page)).toHaveValue("24,2");
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Přidat platbu" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Datum úhrady").fill("2026-10-20");
  await dialog.getByLabel("Měna platby").selectOption("USD");
  await dialog.getByLabel("Částka", { exact: true }).fill("100");
  await expect(dialog.getByLabel(/Připsáno/)).not.toHaveValue("");
  await expect(dialog.getByText("Předvyplněno kurzy ČNB")).toBeVisible();
});
