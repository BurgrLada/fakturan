import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  addCustomer,
  addSupplier,
  chooseCustomer,
  fillLine,
  issue,
  openForm,
  register,
  settled,
} from "./invoice-helpers";

test.setTimeout(90_000);

const money = (text: string) => new RegExp(text.replace(/ /g, "\\s"));

async function paidInvoice(page: Page, baseURL: string) {
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Konzultace", "1000");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await settled(page);
  await issue(page);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("1 000,00 Kč"));
}

test("opravná faktura od tlačítka po přeplatek a vrácení", async ({ page, freshApp }) => {
  await paidInvoice(page, freshApp.baseURL);
  const invoiceUrl = page.url().split("?")[0]!;

  await page.getByRole("button", { name: "Vytvořit opravnou fakturu" }).click();
  await expect(page.getByRole("heading", { name: "Koncept opravné faktury" })).toBeVisible();
  await expect(page.getByTestId("credit-left")).toHaveText(money("Zbývá opravit 1 000,00 Kč."));
  await expect(page.getByLabel("Měna", { exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveCount(0);
  await expect(page.getByTestId("invoice-total")).toHaveText(money("-1 000,00 Kč"));

  await page.getByLabel("Cena za jednotku").fill("-400");
  await expect(page.getByTestId("invoice-total")).toHaveText(money("-400,00 Kč"));
  await settled(page);
  await issue(page);
  await expect(page.getByRole("heading", { name: /Opravná faktura D\d{4}-001/ })).toBeVisible();
  await expect(page.getByTestId("payment-panel")).toHaveCount(0);
  await expect(page.getByTestId("invoice-steps")).not.toContainText("Přeplatek");
  await expect(page.getByRole("button", { name: "Duplikovat" })).toHaveCount(0);

  await page.getByTestId("related-documents").getByRole("link").click();
  await expect(page).toHaveURL(invoiceUrl);
  await expect(page.getByTestId("payment-overpaid")).toHaveText(
    money("Přeplatek k vrácení 400,00 Kč"),
  );
  await expect(page.getByTestId("cancel-blocked")).toBeVisible();

  await page.getByRole("button", { name: "Vrátit peníze" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByLabel("Částka", { exact: true })).toHaveValue(/^400/);
  await dialog.getByRole("button", { name: "Uložit platbu" }).click();

  await expect(page.getByTestId("payment-paid")).toHaveText(money("600,00 Kč"));
  await expect(page.getByTestId("payment-overpaid")).toHaveCount(0);
  const refund = page.getByTestId("payment-row").filter({ hasText: "Vrácení" });
  await expect(refund).toContainText(money("-400,00 Kč"));
  await expect(refund.getByRole("button", { name: "Poslat potvrzení" })).toHaveCount(0);
});

test("úplná oprava a vrácení všeho nechá panel plateb a vrácení jde smazat", async ({
  page,
  freshApp,
}) => {
  await paidInvoice(page, freshApp.baseURL);
  const invoiceUrl = page.url().split("?")[0]!;
  await page.getByRole("button", { name: "Vytvořit opravnou fakturu" }).click();
  await expect(page.getByTestId("invoice-total")).toHaveText(money("-1 000,00 Kč"));
  await issue(page);
  await page.goto(invoiceUrl);

  await page.getByRole("button", { name: "Vrátit peníze" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit platbu" }).click();
  await expect(page.getByText("Dobropisovaná").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Přidat platbu" })).toHaveCount(0);

  const refund = page.getByTestId("payment-row").filter({ hasText: "Vrácení" });
  await refund.getByRole("button", { name: "Smazat" }).click();
  await page.getByRole("button", { name: "Smazat platbu" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("1 000,00 Kč"));
});
