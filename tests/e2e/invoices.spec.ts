import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { unzipSync } from "fflate";
import { decodeQr, pdfPagePng, pdfText } from "../helpers/pdf";
import { expect, test } from "./fixtures";
import {
  addCustomer,
  CUSTOMER,
  cashInvoice,
  chooseCustomer,
  fillLine,
  invite,
  issue,
  openForm,
  PASSWORD,
  ready,
  register,
  settled,
} from "./invoice-helpers";

async function cashIssued(page: Page, baseURL: string, item = "Konzultace", price = "1000") {
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, item, price);
  await settled(page);
  await issue(page);
  return page.url();
}

async function addAccount(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/nastaveni/ucty`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název účtu").fill("Hlavní účet");
  await page.getByLabel("Číslo účtu (i s předčíslím)").fill("2000145399");
  await page.getByLabel("Kód banky").fill("0800");
  await page.getByRole("button", { name: "Uložit účet" }).click();
  await expect(page.getByText("Účet je uložený.")).toBeVisible();
}

const rows = (page: Page) => page.getByRole("table").getByRole("row");

test("[INV-030] [INV-031] hledání, filtr i řazení zůstanou v URL a přežijí obnovení", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL, "Příležitost", "300");
  await cashIssued(page, baseURL, "Konzultace", "200");

  await page.goto(`${baseURL}/faktury`);
  await expect(rows(page)).toHaveCount(3);

  await page.getByRole("searchbox", { name: "Hledat" }).fill("prilezitost");
  await page.getByRole("button", { name: "Použít" }).click();
  await expect(rows(page)).toHaveCount(2);
  await page.waitForURL(/q=prilezitost/);
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("searchbox", { name: "Hledat" })).toHaveValue("prilezitost");

  await page.getByRole("link", { name: "Zrušit filtry" }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("searchbox", { name: "Hledat" })).toHaveValue("");

  await page.getByRole("columnheader", { name: "Celkem" }).getByRole("link").click();
  await page.waitForURL(/razeni=castka&smer=asc/);
  await expect(rows(page).nth(1)).toContainText("200");
  await page.getByRole("columnheader", { name: "Celkem" }).getByRole("link").click();
  await page.waitForURL(/smer=desc/);
  await expect(rows(page).nth(1)).toContainText("300");
  await page.reload();
  await expect(rows(page).nth(1)).toContainText("300");

  await page.goto(`${baseURL}/faktury?stav=nesmysl&mena=XXX&razeni=heslo`);
  await expect(rows(page)).toHaveCount(3);
});

test("[INV-001] [INV-032] souhrn nezapočítá koncept ani storno", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL, "Platí se", "1000");
  const cancelled = await cashIssued(page, baseURL, "Stornuje se", "5000");
  await page.goto(cancelled);
  await page.getByRole("button", { name: "Stornovat" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Stornovat fakturu" }).click();
  await expect(page.getByText("Stornovaná", { exact: true })).toBeVisible();

  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Rozepsané", "7000");
  await settled(page);

  await page.goto(`${baseURL}/faktury`);
  await expect(rows(page)).toHaveCount(4);
  const summary = page.getByTestId("summary-CZK");
  await expect(summary.getByRole("definition").first()).toHaveText(/^1\s000,00\sKč$/);
  await expect(page.getByRole("link", { name: "Koncept" })).toBeVisible();
});

test("[INV-004] detail ukáže stavy, verze a historii", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  const detail = await cashIssued(page, baseURL);
  const steps = page.getByTestId("invoice-steps");
  await expect(steps).toContainText("Vystaveno");
  await expect(page.getByText("Vystavená", { exact: true })).toBeVisible();
  await expect(page.getByText("Doklad zatím nemá starší verze.")).toBeVisible();
  const send = page.getByRole("button", { name: "Odeslat klientovi" });
  await expect(send).toBeDisabled();
  await expect(page.getByText("Odesílání přijde s e-mailem")).toBeVisible();

  await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
  await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Označit jako odeslanou" })).toHaveCount(0);

  await page.getByRole("button", { name: "Stornovat" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Stornovat fakturu" }).click();
  await expect(page.getByText("Stornovaná", { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: "Vrátit storno" }).click();
  await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();

  await page.reload();
  const history = page.getByRole("heading", { name: "Historie faktury" }).locator("..");
  await expect(history.getByRole("listitem")).not.toHaveCount(0);
  expect(page.url()).toBe(detail);
});

test("[INV-021] verze ukáže rozdíl a jde obnovit", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  const detail = await cashIssued(page, baseURL);
  await page.goto(`${detail}/upravit`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Poznámka").fill("Opravená poznámka");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Změny jsou uložené.")).toBeVisible();

  await page.goto(detail);
  await page.getByRole("link", { name: "Verze 1" }).click();
  await expect(page.getByTestId("version-diff")).toContainText("Opravená poznámka");
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await page.waitForURL(/obnoveno=1/);
  await expect(page.getByRole("link", { name: "Verze 2" })).toBeVisible();
});

test("[INV-002] koncept jde smazat z formuláře i ze seznamu, vystavený doklad ne", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);

  await page.getByRole("button", { name: "Smazat koncept" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Smazat koncept" }).click();
  await page.waitForURL(/\/faktury$/);
  await expect(page.getByText("Zatím tu není žádná faktura")).toBeVisible();

  const detail = await cashIssued(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await page.goto(`${baseURL}/faktury`);
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "Smazat koncept: Alfa s.r.o." }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Smazat koncept" }).click();

  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Smazat koncept/ })).toHaveCount(0);
  await page.goto(detail);
  await expect(page.getByRole("button", { name: "Smazat koncept" })).toHaveCount(0);
});

test("[INV-018] duplikace otevře nový koncept", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  const detail = await cashIssued(page, baseURL, "Původní položka");
  await page.getByRole("button", { name: "Duplikovat" }).click();
  await page.waitForURL(/upravit$/);
  expect(page.url()).not.toContain(detail);
  await expect(page.getByRole("combobox", { name: "Název položky" })).toHaveValue(
    "Původní položka",
  );
});

test("[QR-002] detail vysvětlí, proč QR chybí", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL);
  await expect(page.getByTestId("invoice-qr")).toHaveText("QR platba je jen u platby převodem.");
});

test("[TST-015] [TST-018] faktura od nuly po stažené PDF s dekódovaným QR", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await addAccount(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Konzultace", "1500");
  await settled(page);
  await issue(page);
  await expect(page.getByTestId("invoice-qr")).toHaveText("Doklad má QR platbu.");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Stáhnout PDF" }).click(),
  ]);
  const pdf = readFileSync(await download.path());
  expect((await pdfText(pdf)).join("\n")).toContain(CUSTOMER);
  const payload = decodeQr(await pdfPagePng(pdf, 1, 2));
  expect(payload).toContain("AM:1500.00");
  expect(payload).toContain("ACC:CZ");
});

test("[PDF-009] hromadné PDF dá ZIP vybraných dokladů", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL, "První");
  await cashIssued(page, baseURL, "Druhá");
  await cashIssued(page, baseURL, "Třetí");

  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  const boxes = page.getByRole("checkbox", { name: /Vybrat fakturu/ });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("group", { name: "Hromadné akce" })
      .getByRole("button", { name: "Stáhnout PDF" })
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^faktury-\d{4}-\d{2}-\d{2}\.zip$/);
  const entries = unzipSync(readFileSync(await download.path()));
  expect(Object.keys(entries)).toHaveLength(2);
});

test("[INV-005] hromadně označené faktury jsou odeslané", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL, "První");
  await cashIssued(page, baseURL, "Druhá");

  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("checkbox", { name: "Vybrat vše na stránce" }).check();
  await page.getByRole("button", { name: "Označit jako odeslané" }).click();
  await expect(page.getByText("Označeno 2.")).toBeVisible();
  await expect(rows(page).filter({ hasText: "Odeslaná" })).toHaveCount(2);
});

test("[AUD-002] hromadné PDF, které se audituje, se spouští jen ze stejného původu", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  const foreign = await page.request.post(`${baseURL}/faktury/hromadne-pdf`, {
    headers: { origin: "https://example.com" },
    data: { ids: ["x"] },
  });
  expect(foreign.status()).toBe(403);
});

test("[TST-009] cizí detail a verze vrátí 404 a seznam je nevrátí", async ({
  page,
  browser,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  const detail = await cashIssued(page, baseURL);
  await page.goto(`${detail}/upravit`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Poznámka").fill("Změna");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Změny jsou uložené.")).toBeVisible();
  await page.goto(detail);
  await page.getByRole("link", { name: "Verze 1" }).click();
  await page.waitForURL(/verze/);
  const version = page.url();
  expect((await page.goto(`${detail}/verze/neexistuje`))?.status()).toBe(404);

  const link = await invite(page, "cizi@example.cz", baseURL);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(link);
  await guest.getByRole("button", { name: "Pokračovat k registraci" }).click();
  await guest.getByLabel("Jméno").fill("Cizí");
  await guest.getByLabel("Heslo").fill(PASSWORD);
  await guest.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(guest.getByText("cizi@example.cz", { exact: true })).toBeVisible();
  expect((await guest.goto(detail))?.status()).toBe(404);
  expect((await guest.goto(version))?.status()).toBe(404);
  await guest.goto(`${baseURL}/faktury`);
  await expect(guest.getByText("Zatím tu není žádná faktura")).toBeVisible();
  await context.close();
});

test("[UI-007] [UI-009] prázdný seznam nabídne další krok a telefon nepřeteče", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await page.setViewportSize({ width: 390, height: 800 });
  await ready(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await expect(page.getByText("Zatím tu není žádná faktura")).toBeVisible();

  await cashIssued(page, baseURL, "Mobilní položka s dlouhým názvem");
  await page.goto(`${baseURL}/faktury`);
  await expect(rows(page)).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("[INV-017] druhé kliknutí na Nová faktura dá prázdný formulář", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Nová faktura" }).first().click();
  await page.waitForURL(/upravit$/);
  const first = page.url();
  await cashInvoice(page);
  await settled(page);

  await page.getByRole("link", { name: "Zpět na faktury" }).click();
  await page.waitForURL(/\/faktury$/);
  await page.getByRole("link", { name: "Nová faktura" }).first().click();
  await page.waitForURL(/upravit$/);
  expect(page.url()).not.toBe(first);
  await expect(page.getByRole("combobox", { name: "Název položky" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveValue("");
});

test("[INV-001] karta zákazníka ukáže doklady a koncept nezapočítá", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await addCustomer(page, baseURL, "Beta s.r.o.");
  const card = page.url();
  await expect(page.getByText("Zákazník zatím nemá žádný doklad.")).toBeVisible();

  await page.goto(`${baseURL}/zakaznici`);
  await page.getByRole("link", { name: CUSTOMER }).click();
  await page.waitForURL(/\/zakaznici\/[^/]+$/);
  const alfa = page.url();
  expect(alfa).not.toBe(card);
  await cashIssued(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Rozepsané", "7000");
  await settled(page);
  await page.goto(alfa);
  await expect(page.getByRole("link", { name: "Koncept" })).toBeVisible();
  await expect(page.getByTestId("customer-sum-CZK")).toContainText("1 000,00");
});

test("[INV-017] nový koncept je v seznamu i po návratu odkazem", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Nová faktura" }).first().click();
  await page.waitForURL(/upravit$/);
  await page.waitForLoadState("networkidle");
  await cashInvoice(page);
  await settled(page);
  const form = page.url();

  await page.getByRole("link", { name: "Zpět na faktury" }).click();
  await page.waitForURL(/\/faktury$/);
  await expect(page.getByRole("link", { name: "Koncept" })).toHaveCount(1);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText("1 000,00");

  await page.getByRole("link", { name: "Koncept" }).click();
  await page.waitForURL(form);
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Cena za jednotku")).toHaveValue(/1\s?000/);
  await page.getByLabel("Cena za jednotku").fill("2000");
  await settled(page);
  await page.getByRole("link", { name: "Zpět na faktury" }).click();
  await page.waitForURL(/\/faktury$/);
  await expect(rows(page).nth(1)).toContainText("2 000,00");
});

test("[INV-021] po obnovení verze detail upozorní na odeslání a přeplatek", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await ready(page, baseURL);
  const detail = await cashIssued(page, baseURL);
  const id = detail.split("/").at(-1)!;
  await page.goto(`${detail}/upravit`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Cena za jednotku").fill("2000");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Změny jsou uložené.")).toBeVisible();

  await page.goto(detail);
  await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
  await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Verze 1" }).click();
  await expect(page.getByTestId("version-diff")).toContainText("cena");
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await expect(page.getByTestId("restored-notice")).toContainText("zvažte opětovné odeslání");

  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite
    .prepare("UPDATE invoice SET paid_minor = 150000, status = 'partially_paid' WHERE id = ?")
    .run(id);
  sqlite.close();
  await page.goto(detail);
  await expect(page.getByTestId("invoice-steps")).toContainText("Přeplatek");
  await expect(page.getByTestId("invoice-steps")).not.toContainText("Zbývá uhradit");
  await page.getByRole("link", { name: "Verze 2" }).click();
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await page.waitForURL(/obnoveno=1/);
  await page.getByRole("link", { name: "Verze 3" }).click();
  await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();
  await expect(page.getByTestId("restored-notice")).toContainText("Přijaté platby jsou vyšší");
});

test("[INV-004] storno neukáže Zbývá uhradit", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL);
  await expect(page.getByTestId("invoice-steps")).toContainText("Zbývá uhradit");
  await page.getByRole("button", { name: "Stornovat" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Stornovat fakturu" }).click();
  await expect(page.getByText("Stornovaná", { exact: true })).toBeVisible();
  await expect(page.getByTestId("invoice-steps")).not.toContainText("Zbývá uhradit");
});

test("[UI-009] stránka za koncem seznamu netvrdí, že faktury nejsou", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await cashIssued(page, baseURL);
  await page.goto(`${baseURL}/faktury?strana=999`);
  await expect(page.getByText("Na této stránce už nic není")).toBeVisible();
  await expect(page.getByText("Zatím tu není žádná faktura")).toHaveCount(0);
  await page.getByRole("link", { name: "Na první stránku" }).click();
  await expect(rows(page)).toHaveCount(2);
});

test("[INV-017] vypršená relace v ceníku u položky ukáže zámek", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Poznámka").fill("rozepsáno");
  await settled(page);
  const form = page.url();
  await page.getByRole("combobox", { name: "Název položky" }).fill("Bez relace");
  await page.getByLabel("Cena za jednotku").fill("100");
  await settled(page);
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite.prepare("DELETE FROM session").run();
  sqlite.close();

  await page.getByRole("button", { name: "Uložit do ceníku" }).click();
  await expect(page.getByRole("link", { name: "Přihlásit se" })).toBeVisible();
  expect(page.url()).toBe(form);
  await expect(page.getByLabel("Poznámka")).toHaveValue("rozepsáno");
});

test("[INV-017] vypršená relace při hledání v ceníku ukáže zámek", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite.prepare("DELETE FROM session").run();
  sqlite.close();

  await page.getByRole("combobox", { name: "Název položky" }).fill("Hle");
  await expect(page.getByRole("link", { name: "Přihlásit se" })).toBeVisible();
});
