import type { Page } from "@playwright/test";
import { calendarDateInPrague } from "@/lib/number-format";
import { AUTHSERV_ID, noticeText, rawMail, VS } from "../helpers/fio-mail";
import { expect } from "./fixtures";
import { addAccount, chooseCustomer, fillLine, openForm, ready, settled } from "./invoice-helpers";

export const IMAP_PASSWORD = "tajne-heslo-imap-4c1d";
const ACCOUNT = "2000145399/0800";

export type Mailbox = { host: string; port: number; tls: "implicit" | "starttls" };

export async function payableInvoice(page: Page, baseURL: string): Promise<string> {
  await ready(page, baseURL);
  await addAccount(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Konzultace", "1000");
  await settled(page);
  await page.getByRole("button", { name: "Vystavit" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Variabilní symbol").fill(VS);
  await dialog.getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/?]+\?vystaveno=1$/);
  await page.goto(page.url().split("?")[0]!);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("invoice-qr")).toContainText("Doklad má QR platbu");
  return page.url();
}

export async function saveMailbox(page: Page, baseURL: string, { host, port, tls }: Mailbox) {
  await page.goto(`${baseURL}/nastaveni/aviza`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Server IMAP").fill(host);
  await page.getByLabel("Port").fill(String(port));
  await page.getByLabel("Šifrování").selectOption(tls);
  await page.getByLabel("Uživatel").fill("avizo");
  await page.getByLabel("Heslo").fill(IMAP_PASSWORD);
  await page.getByLabel("Server ověření (authserv-id)").fill(AUTHSERV_ID);
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("status")).toContainText("Nastavení schránky je uložené");
}

export function notice(): string {
  const [year, month, day] = calendarDateInPrague(new Date()).split("-");
  return rawMail({
    body: noticeText({
      account: ACCOUNT,
      amount: "1 000,00",
      date: `${day}.${month}.${year}`,
      vs: VS,
    }),
  });
}

export async function checkNow(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/platby`);
  await page.getByRole("button", { name: "Zkontrolovat teď" }).click();
  await expect(page.getByTestId("bank-status")).toContainText("Kontrola je zařazená");
}

export async function expectPaid(page: Page, invoiceUrl: string) {
  await expect
    .poll(
      async () => {
        await page.goto(invoiceUrl);
        return page.getByTestId("invoice-qr").textContent();
      },
      { timeout: 20_000 },
    )
    .toContain("Doklad je uhrazený");
}
