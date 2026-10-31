import type { Page } from "@playwright/test";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { expect, test as base } from "./fixtures";
import {
  addCustomer,
  addSupplier,
  chooseCustomer,
  CUSTOMER,
  fillLine,
  issue,
  openForm,
  register,
  settled,
} from "./invoice-helpers";

// The account's own server: instance SMTP would also demand e-mail verification at registration.
const test = base.extend<{ smtp: TestSmtp }>({
  // oxlint-disable-next-line no-empty-pattern
  smtp: async ({}, use) => {
    const server = await startSmtp();
    await use(server);
    await server.stop();
  },
});

test.use({ allowPrivateMail: true });
test.setTimeout(90_000);

async function ready(page: Page, baseURL: string, smtp: TestSmtp) {
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL, CUSTOMER, "klient@example.cz");
  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Server", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port").fill(String(smtp.port));
  await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
  await page.getByLabel("Uživatel").fill("jan");
  await page.getByLabel("Heslo").fill("heslo-smtp");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByRole("status")).toContainText("Nastavení pošty je uložené");
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

async function issuedCash(page: Page, baseURL: string, price = "1000") {
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", price);
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");
  return page.url();
}

const dialog = (page: Page) => page.getByRole("alertdialog");
const badge = (page: Page, name: string) => page.getByText(name, { exact: true }).first();

async function addPayment(page: Page, amount: string) {
  await page.getByRole("button", { name: "Přidat platbu" }).click();
  await dialog(page).getByLabel("Částka", { exact: true }).fill(amount);
  await dialog(page).getByRole("button", { name: "Uložit platbu" }).click();
  await expect(dialog(page)).toBeHidden();
}

test("[PAY-001] označení jako uhrazené změní stav, QR zmizí a nic neodejde", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  await addAccount(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Konzultace", "1000");
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("invoice-qr")).toContainText("Doklad má QR platbu");

  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();

  await expect(badge(page, "Uhrazená")).toBeVisible();
  await expect(page.getByTestId("invoice-qr")).toContainText("Doklad je uhrazený");
  await expect(page.getByTestId("payment-row")).toHaveCount(1);
  await page.waitForTimeout(2_500);
  expect(smtp.messages).toHaveLength(0);
  expect(smtp.connections()).toBe(0);
});

test("[PAY-002] dílčí platba ukáže zbývající částku a zablokuje storno", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  await issuedCash(page, baseURL);
  await expect(page.getByRole("button", { name: "Stornovat" })).toBeVisible();

  await addPayment(page, "400");

  await expect(badge(page, "Částečně uhrazená")).toBeVisible();
  await expect(page.getByTestId("payment-left")).toContainText("600,00");
  await expect(page.getByRole("button", { name: "Stornovat" })).toHaveCount(0);
  await expect(page.getByTestId("cancel-blocked")).toContainText(
    "Doklad s platbou stornovat nejde",
  );
});

test("[PAY-004] přeplatek je zvýrazněný", async ({ page, freshApp, smtp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  await issuedCash(page, baseURL);

  await addPayment(page, "1200");

  await expect(badge(page, "Uhrazená")).toBeVisible();
  await expect(page.getByTestId("payment-overpaid")).toContainText("Přeplatek");
  await expect(page.getByTestId("payment-overpaid")).toContainText("200,00");
  await expect(page.getByTestId("payment-overpaid")).toHaveClass(/bg-accent/);
});

test("[PAY-005] úprava platby přepočte stav a smazání ho vrátí", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  await issuedCash(page, baseURL);
  await addPayment(page, "1000");
  await expect(badge(page, "Uhrazená")).toBeVisible();

  await page.getByRole("button", { name: "Upravit", exact: true }).click();
  await dialog(page).getByLabel("Částka", { exact: true }).fill("250");
  await dialog(page).getByRole("button", { name: "Uložit platbu" }).click();
  await expect(badge(page, "Částečně uhrazená")).toBeVisible();

  await page.getByRole("button", { name: "Smazat" }).click();
  await dialog(page).getByRole("button", { name: "Smazat platbu" }).click();
  await expect(badge(page, "Vystavená")).toBeVisible();
  await expect(page.getByTestId("payment-row")).toHaveCount(0);
});

test("[PAY-007] uzavření rozdílu vyžaduje potvrzení", async ({ page, freshApp, smtp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  await issuedCash(page, baseURL);
  await addPayment(page, "400");

  await page.getByRole("button", { name: "Uzavřít jako uhrazené" }).click();
  await expect(page.getByTestId("close-difference-body")).toContainText("600,00");
  await dialog(page).getByRole("button", { name: "Zpět" }).click();
  await expect(badge(page, "Částečně uhrazená")).toBeVisible();

  await page.getByRole("button", { name: "Uzavřít jako uhrazené" }).click();
  await dialog(page).getByRole("button", { name: "Uzavřít rozdíl" }).click();

  await expect(badge(page, "Uhrazená")).toBeVisible();
  await expect(page.getByTestId("invoice-steps")).toContainText("Uzavřený rozdíl");
  await expect(page.getByTestId("invoice-steps")).toContainText("600,00");
});

test("[INV-023] úprava uhrazené faktury ukáže upozornění a stav po přepočtu", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  const detail = await issuedCash(page, baseURL);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(badge(page, "Uhrazená")).toBeVisible();

  await page.goto(`${detail}/upravit`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Měna", { exact: true })).toBeDisabled();
  await page.getByLabel("Cena za jednotku").first().fill("1500");
  await page.getByRole("button", { name: "Uložit změny" }).click();

  await expect(page.getByText("Přijaté platby jsou nižší než nová částka faktury.")).toBeVisible();
  await expect(page.getByText("Stav po přepočtu: Částečně uhrazená.")).toBeVisible();
});

test("[CUS-006] karta zákazníka ukáže uhrazeno, pohledávky a průměrnou dobu úhrady", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  const detail = await issuedCash(page, baseURL);
  await page.getByRole("link", { name: "Alfa s.r.o." }).click();
  await page.waitForURL(/\/zakaznici\/[^/]+$/);
  const card = page.url();
  await expect(page.getByTestId("customer-average-days")).toContainText("–");
  await expect(page.getByTestId("customer-sum-CZK")).toContainText("Pohledávky");

  await page.goto(detail);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(badge(page, "Uhrazená")).toBeVisible();

  await page.goto(card);
  await expect(page.getByTestId("customer-average-days")).toContainText("0 dní");
  await expect(page.getByTestId("customer-sum-CZK")).toContainText("1 000,00");
});

test("[INV-024] hromadné označení přeskočí koncept a storno a nic neodešle", async ({
  page,
  freshApp,
  smtp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL, smtp);
  await issuedCash(page, baseURL, "1000");
  await issuedCash(page, baseURL, "500");
  await issuedCash(page, baseURL, "300");
  await page.getByRole("button", { name: "Stornovat", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Stornovat fakturu" }).click();
  await expect(badge(page, "Stornovaná")).toBeVisible();
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await fillLine(page, 0, "Rozepsané", "7000");
  await settled(page);

  await page.goto(`${baseURL}/faktury`);
  await page.getByLabel("Vybrat vše na stránce").check();
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("bulk-paid-summary")).toContainText("Počet dokladů: 2");
  await expect(page.getByTestId("bulk-paid-summary")).toContainText(/1\s500,00/);
  await dialog(page).getByRole("button", { name: "Označit jako uhrazené" }).click();

  await expect(page.getByText("Uhrazeno 2, přeskočeno 1.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Uhrazená" })).toHaveCount(2);
  await page.waitForTimeout(2_500);
  expect(smtp.messages).toHaveLength(0);
});
