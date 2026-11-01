import type { Page } from "@playwright/test";
import { startImap } from "../helpers/imap";
import { checkNow, expectPaid, notice, payableInvoice, saveMailbox } from "./bank-flow";
import { expect, test } from "./fixtures";

test.setTimeout(120_000);
test.use({ allowPrivateMail: true });

const dialog = (page: Page) => page.getByRole("alertdialog");

test("avízo od zprávy po vrácení a přiřazení", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  const imap = await startImap();
  try {
    const invoiceUrl = await payableInvoice(page, baseURL);
    await saveMailbox(page, baseURL, { host: "127.0.0.1", port: imap.port, tls: "starttls" });

    imap.addMessage(notice());
    await checkNow(page, baseURL);
    await expectPaid(page, invoiceUrl);
    await expect(page.getByText("Uhrazená", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("payment-row")).toContainText("Z avíza");

    await page.getByRole("button", { name: "Vrátit avízo" }).click();
    await dialog(page).getByRole("button", { name: "Vrátit avízo" }).click();
    await expect(page.getByTestId("payment-row")).toHaveCount(0);
    await expect(page.getByTestId("invoice-qr")).toContainText("Doklad má QR platbu");

    await page.goto(`${baseURL}/platby`);
    const row = page.getByTestId("notice-row");
    await expect(row).toContainText("Spárování bylo vráceno.");
    await row.getByRole("button", { name: "Přiřadit" }).click();
    await dialog(page).getByLabel("Doklad", { exact: true }).selectOption({ index: 1 });
    await dialog(page).getByRole("button", { name: "Přiřadit platbu" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(row).toContainText("Spárováno");

    await expectPaid(page, invoiceUrl);
    await expect(page.getByTestId("payment-row")).toHaveCount(1);
  } finally {
    await imap.close();
  }
});
