import type { Page } from "@playwright/test";
import { startImap } from "../helpers/imap";
import { startSmtp } from "../helpers/smtp";
import { VS } from "../helpers/fio-mail";
import { checkNow, notice, saveMailbox } from "./bank-flow";
import { expect, test } from "./fixtures";
import {
  addAccount,
  addCustomer,
  addSupplier,
  chooseCustomer,
  CUSTOMER,
  fillLine,
  issue,
  ownServer,
  register,
  settled,
} from "./invoice-helpers";

test.setTimeout(90_000);

const money = (text: string) => new RegExp(text.replace(/ /g, "\\s"));

// The default mode leaves a draft behind the payment, so there is nothing left to convert by hand.
async function openAutomaticDraft(page: Page) {
  await expect(page.getByRole("button", { name: "Vytvořit konečnou fakturu" })).toHaveCount(0);
  await page.getByTestId("related-documents").getByRole("link", { name: "Koncept" }).click();
  await expect(page.getByRole("heading", { name: "Koncept faktury" })).toBeVisible();
}

test("záloha, úhrada, faktura", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);

  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová záloha" }).click();
  await expect(page.getByRole("heading", { name: "Nová záloha" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await chooseCustomer(page);
  await fillLine(page, 0, "Záloha na web", "10000");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await settled(page);
  await issue(page);
  await expect(page.getByRole("heading", { name: /Zálohová faktura Z\d{4}-001/ })).toBeVisible();
  const advanceUrl = page.url().split("?")[0]!;

  await page.goto(`${baseURL}/faktury`);
  await expect(page.getByTestId("summary-advance-open")).toHaveText(money("10 000,00 Kč"));
  await expect(page.getByTestId("summary-CZK")).toContainText("Neuhrazené zálohy");

  await page.goto(advanceUrl);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("10 000,00 Kč"));

  await openAutomaticDraft(page);
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await issue(page);

  await expect(page.getByRole("heading", { name: /Faktura \d{4}-001/ })).toBeVisible();
  const steps = page.getByTestId("invoice-steps");
  await expect(steps).toContainText("Uhrazeno zálohou");
  await expect(steps).toContainText(money("Zbývá uhradit0,00 Kč"));
  const related = page.getByTestId("related-documents");
  await expect(related).toContainText("Záloha");
  await related.getByRole("link").click();

  await expect(page).toHaveURL(advanceUrl);
  await page.goto(advanceUrl);
  await expect(page.getByTestId("related-documents")).toContainText("Nahrazeno fakturou");
  await expect(page.getByText("Nahrazená")).toBeVisible();
  await expect(page.getByRole("button", { name: "Přidat platbu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vytvořit konečnou fakturu" })).toHaveCount(0);
  await expect(page.getByTestId("cancel-blocked")).toBeVisible();
  await expect(page.getByTestId("payment-panel")).toBeVisible();
});

test("faktura uhrazená zálohou: přeplatek odkazuje na zálohu a storno ji vrátí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová záloha" }).click();
  await page.waitForLoadState("networkidle");
  await chooseCustomer(page);
  await fillLine(page, 0, "Záloha na web", "1000");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await settled(page);
  await issue(page);
  const advanceUrl = page.url();
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("1 000,00 Kč"));
  await openAutomaticDraft(page);
  await page.waitForLoadState("networkidle");
  await issue(page);
  const finalUrl = page.url();

  await page.getByRole("button", { name: "Vytvořit opravnou fakturu" }).click();
  await expect(page.getByRole("heading", { name: "Koncept opravné faktury" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Cena za jednotku").fill("-400");
  await settled(page);
  await issue(page);
  const noteUrl = page.url();
  await page.goto(finalUrl);
  await expect(page.getByTestId("payment-overpaid-advance").getByRole("link")).toHaveAttribute(
    "href",
    new URL(advanceUrl).pathname,
  );

  await page.goto(noteUrl);
  await page.getByRole("button", { name: "Stornovat" }).click();
  await page.getByRole("button", { name: "Stornovat fakturu" }).click();
  await expect(page.getByText("Stornovaná").first()).toBeVisible();

  await page.goto(finalUrl);
  await expect(page.getByTestId("cancel-covered")).toBeVisible();
  await page.getByRole("button", { name: "Stornovat" }).click();
  await page.getByRole("button", { name: "Stornovat fakturu" }).click();
  await expect(page.getByRole("button", { name: "Vrátit storno" })).toBeVisible();

  await page.goto(advanceUrl);
  await expect(page.getByText("Nahrazená")).toHaveCount(0);
  await expect(page.getByTestId("related-documents")).not.toContainText("Nahrazeno fakturou");
});

async function issuedCashAdvance(page: Page, baseURL: string) {
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová záloha" }).click();
  await page.waitForLoadState("networkidle");
  await chooseCustomer(page);
  await fillLine(page, 0, "Záloha na web", "1000");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await settled(page);
  await issue(page);
  return page.url();
}

test("doplatek po záloze jde uzavřít a záloha odkáže na rozdíl na faktuře", async ({
  page,
  freshApp,
}) => {
  const advanceUrl = await issuedCashAdvance(page, freshApp.baseURL);
  await page.getByRole("button", { name: "Označit jako uhrazené" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("1 000,00 Kč"));
  await openAutomaticDraft(page);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Cena za jednotku").fill("1000,50");
  await settled(page);
  await issue(page);
  const finalUrl = page.url();

  await page.getByRole("button", { name: "Uzavřít jako uhrazené" }).click();
  await page.getByRole("button", { name: "Uzavřít rozdíl" }).click();
  await expect(page.getByTestId("invoice-steps")).toContainText("Uzavřený rozdíl");

  await page.goto(advanceUrl);
  await expect(page.getByTestId("payment-closed-final").getByRole("link")).toHaveAttribute(
    "href",
    new URL(finalUrl).pathname,
  );
  await expect(page.getByRole("button", { name: "Vrátit peníze" })).toHaveCount(0);
});

test("přeplatek po záloze s uzavřeným rozdílem řekne, co udělat na záloze", async ({
  page,
  freshApp,
}) => {
  const advanceUrl = await issuedCashAdvance(page, freshApp.baseURL);
  await page.getByRole("button", { name: "Přidat platbu" }).click();
  await page.getByRole("alertdialog").getByLabel("Částka", { exact: true }).fill("900");
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit platbu" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("900,00 Kč"));
  await page.getByRole("button", { name: "Uzavřít jako uhrazené" }).click();
  await page.getByRole("button", { name: "Uzavřít rozdíl" }).click();
  await expect(page.getByTestId("payment-paid")).toHaveText(money("1 000,00 Kč"));
  await openAutomaticDraft(page);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Cena za jednotku").fill("900");
  await settled(page);
  await issue(page);

  const hint = page.getByTestId("payment-overpaid-advance");
  await expect(hint).toContainText("uzavřený rozdíl");
  await expect(hint.getByRole("link")).toHaveAttribute("href", new URL(advanceUrl).pathname);
});

test.describe("kritický tok", () => {
  test.use({ allowPrivateMail: true });
  test.setTimeout(150_000);

  test("záloha z avíza po fakturu, odeslání a vrácení", async ({ page, freshApp }) => {
    const { baseURL } = freshApp;
    const client = "klient@example.cz";
    const imap = await startImap();
    const smtp = await startSmtp();
    try {
      await register(page, baseURL);
      await addSupplier(page, baseURL);
      await addCustomer(page, baseURL, CUSTOMER, client);
      await addAccount(page, baseURL);
      await ownServer(page, baseURL, smtp.port);
      await saveMailbox(page, baseURL, { host: "127.0.0.1", port: imap.port, tls: "starttls" });

      await page.goto(`${baseURL}/nastaveni/automatizace`);
      await page.waitForLoadState("networkidle");
      const automation = page
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name: "Odeslání po záloze" }) });
      await automation.getByLabel("Po úhradě zálohy").selectOption("issue");
      await expect(page.getByRole("status").filter({ hasText: "Uloženo." })).toBeVisible();
      await automation.getByRole("button", { name: "Zapnout" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Zapnout a potvrdit" })
        .click();
      await expect(automation).toContainText("Zapnuto");

      await page.goto(`${baseURL}/faktury`);
      await page.getByRole("link", { name: "Nová záloha" }).click();
      await page.waitForLoadState("networkidle");
      await chooseCustomer(page);
      await fillLine(page, 0, "Záloha na web", "1000");
      await settled(page);
      await page.getByRole("button", { name: "Vystavit" }).click();
      const issueDialog = page.getByRole("alertdialog");
      await issueDialog.getByLabel("Variabilní symbol").fill(VS);
      await issueDialog.getByRole("button", { name: "Vystavit" }).click();
      await page.waitForURL(/\/faktury\/[^/?]+\?vystaveno=1$/);
      const advanceUrl = page.url().split("?")[0]!;

      imap.addMessage(notice());
      await checkNow(page, baseURL);
      await expect
        .poll(
          async () => {
            await page.goto(advanceUrl);
            return page.getByTestId("payment-row").count();
          },
          { timeout: 20_000 },
        )
        .toBe(1);
      await expect(page.getByTestId("payment-row")).toContainText("Z avíza");

      await page.getByTestId("related-documents").getByRole("link").click();
      await expect(page.getByRole("heading", { name: /Faktura \d{4}-001/ })).toBeVisible();
      const finalUrl = page.url();
      await page.goto(finalUrl);
      await expect(page.getByTestId("email-history")).toContainText("Odesláno", {
        timeout: 20_000,
      });
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.to).toContain(client);
      await expect(page.getByTestId("invoice-steps")).toContainText("Uhrazeno zálohou");

      await page.goto(advanceUrl);
      await page.getByRole("button", { name: "Vrátit avízo" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Vrátit avízo" }).click();
      await expect(page.getByTestId("payment-row")).toHaveCount(0);

      await page.goto(finalUrl);
      await expect(page.getByTestId("invoice-steps")).toContainText(
        money("Zbývá uhradit1 000,00 Kč"),
      );
      await page.goto(`${baseURL}/upozorneni`);
      await expect(page.getByText("opět chce doplatek")).toBeVisible();
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await imap.close();
      await smtp.stop();
    }
  });
});

test("plán pravidelné faktury nabízí zálohu a text zálohy jde upravit", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);

  await expect(page.getByLabel("Text na záloze (česky)")).toHaveValue("Toto není daňový doklad.");

  await page.goto(`${baseURL}/pravidelne/nova`);
  const type = page.getByLabel("Typ dokladu");
  await expect(type.locator("option")).toHaveText(["Faktura", "Zálohová faktura"]);
});
