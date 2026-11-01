import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "./fixtures";
import {
  chooseCurrency,
  chooseCustomer,
  eurAccount,
  fillLine,
  foreignCustomer,
  identified,
  issue,
  issuedPdf,
  openForm,
  ready,
  settled,
} from "./invoice-helpers";

test.setTimeout(120_000);

const ISSUED_ON = "2026-10-20";
const LIST_RATE = 24_200_000;

function withDatabase<T>(dataDir: string, work: (sqlite: Database.Database) => T): T {
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  try {
    return work(sqlite);
  } finally {
    sqlite.close();
  }
}

test("zahraniční faktura v EUR od zákazníka po platbu", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  await ready(page, baseURL);
  await identified(page, baseURL);
  await foreignCustomer(page, baseURL, "Müller GmbH", "DE123456789");
  await eurAccount(page, baseURL, "EUR", "FIOBCZPP");

  await openForm(page, baseURL);
  await chooseCustomer(page, "Müller GmbH");
  await expect(page.getByLabel("Zahraniční faktura")).toBeChecked();
  await expect(page.getByLabel("Doložka na faktuře")).toHaveValue(/Daň odvede zákazník/);
  await fillLine(page, 0, "Konzultace", "100");
  await page.getByLabel("Datum vystavení").fill(ISSUED_ON);
  await chooseCurrency(page, "EUR");
  await expect(page.getByLabel("Kurz k CZK")).toHaveValue("24,2");
  await expect(page.getByTestId("rate-source")).toContainText("Kurz ČNB k");
  await expect(page.getByTestId("form-qr-reason")).toHaveCount(0);
  await settled(page);
  await issue(page);

  await expect(page.getByTestId("invoice-qr")).toHaveText("Doklad má QR platbu SEPA.");
  const text = await issuedPdf(page);
  expect(text).toContain("100,00 €");
  expect(text).toContain("Daň odvede zákazník");
  expect(text).toContain("DE123456789");
  expect(text).not.toContain("24,2");
  const detail = page.url();

  const issuedRate = () =>
    withDatabase(dataDir, (sqlite) =>
      sqlite.prepare("SELECT exchange_rate_micros FROM invoice").pluck().get(),
    );
  expect(issuedRate()).toBe(LIST_RATE);
  withDatabase(dataDir, (sqlite) =>
    sqlite.prepare("UPDATE exchange_rate SET rate_micros = 26000000 WHERE currency = 'EUR'").run(),
  );
  await page.goto(detail);
  await page.waitForLoadState("networkidle");
  expect(issuedRate()).toBe(LIST_RATE);

  await page.getByRole("button", { name: "Přidat platbu" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Datum úhrady").fill("2026-10-21");
  await dialog.getByLabel("Měna platby").selectOption("USD");
  await dialog.getByLabel("Částka", { exact: true }).fill("108,51");
  await expect(dialog.getByLabel(/Připsáno/)).toHaveValue("100,00");
  await expect(dialog.getByText("Předvyplněno kurzy ČNB")).toBeVisible();
  await dialog.getByRole("button", { name: "Uložit platbu" }).click();

  await expect(page.getByTestId("payment-paid")).toContainText("100,00 €");
  await expect(page.getByText("Uhrazená", { exact: true }).first()).toBeVisible();
  expect(issuedRate()).toBe(LIST_RATE);
});
