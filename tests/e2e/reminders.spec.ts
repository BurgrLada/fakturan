import { join } from "node:path";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { expect, test as base } from "./fixtures";
import {
  addCustomer,
  addSupplier,
  cashInvoice,
  CUSTOMER,
  issue,
  openForm,
  register,
  settled,
} from "./invoice-helpers";

const CLIENT = "klient@example.cz";

const test = base.extend<{ smtp: TestSmtp }>({
  // oxlint-disable-next-line no-empty-pattern
  smtp: async ({}, use) => {
    const server = await startSmtp();
    await use(server);
    await server.stop();
  },
});

test.setTimeout(90_000);
test.use({ allowPrivateMail: true });

async function ownServer(page: Page, baseURL: string, port: number) {
  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Server", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port").fill(String(port));
  await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
  await page.getByLabel("Uživatel").fill("jan");
  await page.getByLabel("Heslo").fill("heslo-smtp");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByRole("status")).toContainText("Nastavení pošty je uložené");
}

async function issuedInvoice(page: Page, baseURL: string, port: number) {
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL, CUSTOMER, CLIENT);
  await ownServer(page, baseURL, port);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");
  return page.url();
}

function setDueDate(dataDir: string, offsetDays: number) {
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite
    .prepare("UPDATE invoice SET due_date = date('now', ?)")
    .run(`${offsetDays >= 0 ? "+" : ""}${offsetDays} days`);
  sqlite.close();
}

test("[REM-003] ruční upomínka z faktury", async ({ page, freshApp, smtp }) => {
  const { baseURL } = freshApp;
  const detail = await issuedInvoice(page, baseURL, smtp.port);

  await page.goto(`${baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Přidat stupeň" }).click();
  await page.getByLabel("Dny od splatnosti").fill("5");
  await page.getByLabel("Předmět (cs)").fill("Druhá výzva {{cislo_faktury}}");
  await page.getByLabel("Text (cs)").fill("Zbývá {{zbyva}}.");
  await page.getByRole("button", { name: "Uložit stupeň" }).click();
  await expect(page.getByTestId("reminder-rule")).toContainText("5 dní po splatnosti");

  await page.goto(detail);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
  await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
  await page.getByLabel("Stupeň").selectOption({ label: "5 dní po splatnosti" });
  await page.getByRole("button", { name: "Odeslat upomínku" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByLabel("Předmět")).toHaveValue(/^Druhá výzva /);
  await dialog.getByRole("button", { name: "Odeslat", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const mail = await smtp.waitFor(CLIENT);
  expect(mail.subject).toMatch(/^Druhá výzva /);
  expect(mail.attachments).toHaveLength(1);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("reminder-history")).toContainText("ručně", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await page.waitForLoadState("networkidle");
  await page.getByLabel("Stupeň").selectOption({ label: "5 dní po splatnosti" });
  await page.getByRole("button", { name: "Odeslat upomínku" }).click();
  await expect(dialog.getByRole("button", { name: "Odeslat", exact: true })).toBeDisabled();
  await dialog.getByLabel("Rozumím, chci ji poslat znovu").check();
  await expect(dialog.getByRole("button", { name: "Odeslat", exact: true })).toBeEnabled();
});

test("[REM-009] po splatnosti a blížící se splatnost jsou v centru i na Přehledu", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await issuedInvoice(page, baseURL, smtp.port);

  setDueDate(dataDir, -2);
  await page.goto(baseURL);
  await expect(page.getByTestId("alerts-overdue")).toContainText(CUSTOMER);
  await page.getByTestId("alerts-overdue").getByRole("link", { name: "Zobrazit vše" }).click();
  await expect(page).toHaveURL(/stav=po-splatnosti/);
  await page.goto(`${baseURL}/upozorneni`);
  await expect(page.getByText("Faktury po splatnosti: 1")).toBeVisible();

  setDueDate(dataDir, 2);
  await page.goto(baseURL);
  await expect(page.getByTestId("alerts-due-soon")).toContainText(CUSTOMER);
  await page.goto(`${baseURL}/upozorneni`);
  await expect(page.getByText("Faktury se splatností do 3 dnů: 1")).toBeVisible();
});
