import type { Page } from "@playwright/test";
import { pdfText } from "../helpers/pdf";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { expect, test as base } from "./fixtures";
import {
  addCustomer,
  addSupplier,
  cashInvoice,
  CUSTOMER,
  issue,
  issueWithOffer,
  openForm,
  register,
  settled,
} from "./invoice-helpers";

const CLIENT = "klient@example.cz";

// The account's own server: instance SMTP would also demand e-mail verification at registration.
const test = base.extend<{ smtp: TestSmtp }>({
  // oxlint-disable-next-line no-empty-pattern
  smtp: async ({}, use) => {
    const server = await startSmtp();
    await use(server);
    await server.stop();
  },
});

test.setTimeout(90_000);

async function prepare(page: Page, baseURL: string) {
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL, CUSTOMER, CLIENT);
}

async function ownServer(page: Page, baseURL: string, port: number, cc = "", bcc = "") {
  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Server", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port").fill(String(port));
  await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
  await page.getByLabel("Uživatel").fill("jan");
  await page.getByLabel("Heslo").fill("heslo-smtp");
  await page.getByLabel("Stálá kopie (Cc)").fill(cc);
  await page.getByLabel("Stálá skrytá kopie (Bcc)").fill(bcc);
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByRole("status")).toContainText("Nastavení pošty je uložené");
}

async function connected(page: Page, baseURL: string, smtp: TestSmtp, cc = "", bcc = "") {
  await prepare(page, baseURL);
  await ownServer(page, baseURL, smtp.port, cc, bcc);
}

async function issued(page: Page, baseURL: string) {
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");
  return page.url();
}

const sendButton = (page: Page) => page.getByRole("button", { name: "Odeslat klientovi" });
const dialog = (page: Page) => page.getByRole("alertdialog");
const submit = (page: Page) => dialog(page).getByRole("button", { name: "Odeslat", exact: true });

async function openDialog(page: Page) {
  await sendButton(page).first().click();
  await expect(dialog(page).getByLabel("Příjemci")).toHaveValue(CLIENT);
}

async function delivered(page: Page) {
  await expect(page.getByTestId("email-history")).toContainText("Odesláno", { timeout: 20_000 });
}

// Long enough for several 1 s scheduler ticks to have picked up anything wrongly queued.
async function nothingLeaves(page: Page, smtp: TestSmtp) {
  await page.waitForTimeout(2_500);
  expect(smtp.messages).toHaveLength(0);
  expect(smtp.connections()).toBe(0);
}

test.describe("se SMTP", () => {
  test.use({ allowPrivateMail: true });

  test("[MAIL-001] tlačítko Odeslat klientovi je na detailu vystavené i odeslané faktury a chybí na konceptu a stornu", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await openForm(page, baseURL);
    await cashInvoice(page);
    await settled(page);
    await expect(sendButton(page)).toHaveCount(0);

    await issue(page);
    await expect(sendButton(page)).toBeEnabled();
    await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
    await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
    await expect(sendButton(page)).toBeEnabled();

    await page.getByRole("button", { name: "Stornovat" }).click();
    await dialog(page).getByRole("button", { name: "Stornovat fakturu" }).click();
    await expect(page.getByText("Stornovaná", { exact: true })).toBeVisible();
    await expect(sendButton(page)).toHaveCount(0);
  });

  test("po vystavení se nabídne odeslání a nic neodejde bez kliknutí", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await openForm(page, baseURL);
    await cashInvoice(page);
    await settled(page);
    await issueWithOffer(page);

    await expect(page.getByTestId("send-offer")).toContainText("Chcete ji odeslat klientovi");
    await nothingLeaves(page, smtp);

    await page.reload();
    await nothingLeaves(page, smtp);
    await page.getByTestId("send-offer").getByRole("button").click();
    await expect(dialog(page).getByLabel("Příjemci")).toHaveValue(CLIENT);
    await submit(page).click();
    await delivered(page);
    await expect(page.getByTestId("send-offer")).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
  });

  test("odeslání z dialogu s upraveným předmětem a přílohou PDF a odebranou stálou kopií", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp, "ucetni@example.cz", "archiv@example.cz");
    await issued(page, baseURL);

    await openDialog(page);
    await expect(dialog(page).getByLabel("Kopie", { exact: true })).toHaveValue(
      "ucetni@example.cz",
    );
    await expect(dialog(page).getByLabel("Skrytá kopie")).toHaveValue("archiv@example.cz");
    await expect(page.getByTestId("send-attachment")).toContainText(".pdf");
    await dialog(page).getByLabel("Kopie", { exact: true }).fill("");
    await dialog(page).getByLabel("Předmět").fill("Upravený předmět");
    await dialog(page).getByLabel("Text", { exact: true }).fill("Upravený text");
    await submit(page).click();
    await delivered(page);

    const mail = await smtp.waitFor(CLIENT);
    expect(mail.to.toSorted()).toEqual(["archiv@example.cz", CLIENT]);
    expect(mail.subject).toBe("Upravený předmět");
    expect(mail.body.trim()).toBe("Upravený text");
    expect(mail.attachments).toHaveLength(1);
  });

  test("skutečné doručení přes frontu v produkčním buildu", async ({ page, freshApp, smtp }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp, "ucetni@example.cz", "archiv@example.cz");
    const detail = await issued(page, baseURL);
    const number = (await page.getByRole("heading", { level: 1 }).innerText()).replace(
      "Faktura ",
      "",
    );

    await openDialog(page);
    await submit(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await delivered(page);

    const mail = await smtp.waitFor(CLIENT);
    expect(smtp.messages).toHaveLength(1);
    expect(mail.to.toSorted()).toEqual(["archiv@example.cz", CLIENT, "ucetni@example.cz"]);
    expect(mail.raw).toMatch(/^Cc: ucetni@example\.cz/im);
    expect(mail.raw).not.toContain("archiv@example.cz");
    const [attachment] = mail.attachments;
    expect(attachment.filename).toMatch(/\.pdf$/);
    expect(attachment.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await pdfText(attachment.content)).join("\n")).toContain(number);

    await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
    const archive = await page.request.get(
      (await page
        .getByRole("link", { name: "Stáhnout odeslané PDF" })
        .evaluate((a: HTMLAnchorElement) => a.href)) as string,
    );
    expect(archive.status()).toBe(200);
    expect((await archive.body()).equals(attachment.content)).toBe(true);
    expect((await page.goto(detail))?.status()).toBe(200);
  });

  test("dialog při nevyřešeném unknown bez potvrzení neodešle, po potvrzení ano", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);

    smtp.dropDuringData();
    await openDialog(page);
    await submit(page).click();
    await expect(page.getByTestId("send-problem")).toContainText("Nevíme, zda odešlo", {
      timeout: 20_000,
    });
    expect(smtp.messages).toHaveLength(0);

    await openDialog(page);
    await expect(dialog(page)).toContainText("může klient dostat dvakrát");
    await expect(submit(page)).toBeDisabled();
    await dialog(page).getByLabel("Rozumím, klient může dostat zprávu dvakrát").check();
    await submit(page).click();
    await delivered(page);
    expect(smtp.messages).toHaveLength(1);
    await expect(page.getByTestId("send-problem")).toHaveCount(0);
  });

  test("[MAIL-005] Beru na vědomí uzavře unknown po ručním označení jako odeslané", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);

    smtp.dropDuringData();
    await openDialog(page);
    await submit(page).click();
    await expect(page.getByTestId("send-problem")).toContainText("Nevíme, zda odešlo", {
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
    await page.getByRole("button", { name: "Beru na vědomí" }).click();

    await expect(page.getByRole("button", { name: "Beru na vědomí" })).toHaveCount(0);
    await expect(page.getByTestId("send-problem")).toHaveCount(0);
    expect(smtp.messages).toHaveLength(0);
  });

  test("Odeslat ručně u unknown žádá potvrzení a pošle stejný text", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);

    smtp.dropDuringData();
    await openDialog(page);
    await dialog(page).getByLabel("Předmět").fill("Ruční pokus");
    await submit(page).click();
    const problem = page.getByTestId("send-problem");
    await expect(problem).toContainText("Nevíme, zda odešlo", { timeout: 20_000 });

    await problem.getByRole("button", { name: "Odeslat ručně" }).click();
    await expect(page.getByTestId("resend-summary")).toContainText("Ruční pokus");
    await expect(submit(page)).toBeDisabled();
    await dialog(page).getByLabel("Rozumím, klient může dostat zprávu dvakrát").check();
    await submit(page).click();
    await delivered(page);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].subject).toBe("Ruční pokus");
  });

  test("po změně dokladu nabídne znovu odeslání čerstvou zprávu a dvě karty nepustí starý text", async ({
    page,
    context,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    const detail = await issued(page, baseURL);
    smtp.rejectNext(550);
    await openDialog(page);
    await dialog(page).getByLabel("Předmět").fill("Starý předmět");
    await submit(page).click();
    await expect(page.getByTestId("send-problem")).toContainText("Neodesláno", {
      timeout: 20_000,
    });

    await openDialog(page);
    const other = await context.newPage();
    await other.goto(`${detail}/upravit`);
    await other.waitForLoadState("networkidle");
    await other.getByLabel("Poznámka").fill("Změna");
    await other.getByRole("button", { name: "Uložit změny" }).click();
    await expect(other.getByText("Změny jsou uložené.")).toBeVisible();
    await other.close();

    await submit(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("Doklad se mezitím změnil");
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole("button", { name: "Zpět" }).click();

    await page.reload();
    await page.getByTestId("email-history").getByRole("button", { name: "Odeslat znovu" }).click();
    await expect(dialog(page)).toContainText("sestavená znovu");
    await expect(dialog(page).getByLabel("Předmět")).not.toHaveValue("Starý předmět");
    const rebuilt = await dialog(page).getByLabel("Předmět").inputValue();
    expect(rebuilt).not.toBe("");
    await submit(page).click();
    await delivered(page);
    expect(smtp.messages[0].subject).toBe(rebuilt);
    expect(smtp.messages[0].subject).not.toBe("Starý předmět");
  });

  test("pozdní unknown z jiné karty ukáže v otevřeném dialogu potvrzení", async ({
    page,
    context,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    const detail = await issued(page, baseURL);
    await openDialog(page);

    smtp.dropDuringData();
    const other = await context.newPage();
    await other.goto(detail);
    await other.waitForLoadState("networkidle");
    await openDialog(other);
    await submit(other).click();
    await expect(other.getByTestId("send-problem")).toContainText("Nevíme, zda odešlo", {
      timeout: 20_000,
    });
    await other.close();

    await submit(page).click();
    const confirm = dialog(page).getByLabel("Rozumím, klient může dostat zprávu dvakrát");
    await expect(confirm).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await confirm.check();
    await submit(page).click();
    await delivered(page);
    expect(smtp.messages).toHaveLength(1);
  });

  test("chyba předvyplnění se ukáže místo věčného načítání", async ({
    page,
    context,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    const detail = await issued(page, baseURL);

    const other = await context.newPage();
    await other.goto(detail);
    await other.waitForLoadState("networkidle");
    await other.getByRole("button", { name: "Stornovat" }).click();
    await dialog(other).getByRole("button", { name: "Stornovat fakturu" }).click();
    await expect(other.getByText("Stornovaná", { exact: true })).toBeVisible();
    await other.close();

    await sendButton(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText("Tento doklad nejde odeslat");
    await expect(dialog(page)).not.toContainText("Připravuji zprávu");
  });

  test("znovu odeslání z historie jde přes dialog a nic neodejde bez potvrzení", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);

    smtp.rejectNext(550);
    await openDialog(page);
    await dialog(page).getByLabel("Předmět").fill("Pro historii");
    await submit(page).click();
    await expect(page.getByTestId("send-problem")).toContainText("Neodesláno", {
      timeout: 20_000,
    });

    const history = page.getByTestId("email-history");
    await history.getByRole("button", { name: "Odeslat znovu" }).click();
    const summary = page.getByTestId("resend-summary");
    await expect(summary).toContainText(CLIENT);
    await expect(summary).toContainText("Pro historii");
    await dialog(page).getByRole("button", { name: "Zpět" }).click();
    await page.waitForTimeout(2_500);
    expect(smtp.messages).toHaveLength(0);

    await history.getByRole("button", { name: "Odeslat znovu" }).click();
    await expect(summary).toContainText(CLIENT);
    await submit(page).click();
    await delivered(page);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].subject).toBe("Pro historii");
  });

  test("[INV-020] po úpravě odeslané faktury se nabídne opětovné odeslání a nic neodejde", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    const detail = await issued(page, baseURL);
    await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
    await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();

    await page.goto(`${detail}/upravit`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Poznámka").fill("Oprava");
    await page.getByRole("button", { name: "Uložit změny" }).click();
    const offer = page.getByTestId("send-offer");
    await expect(offer).toContainText("zvažte opětovné odeslání");
    await offer.getByRole("link", { name: "Odeslat klientovi" }).click();

    await page.waitForURL(/odeslat=1/);
    await expect(offer.getByRole("button", { name: "Odeslat klientovi" })).toBeVisible();
    await nothingLeaves(page, smtp);
  });

  test("resendSuggested po obnovení verze otevře nabídku, ne odeslání", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    const detail = await issued(page, baseURL);
    await page.goto(`${detail}/upravit`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Poznámka").fill("Změna");
    await page.getByRole("button", { name: "Uložit změny" }).click();
    await expect(page.getByText("Změny jsou uložené.")).toBeVisible();

    await page.goto(detail);
    await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
    await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Verze 1" }).click();
    await page.getByRole("button", { name: "Obnovit tuto verzi" }).click();

    await expect(page.getByTestId("send-offer")).toContainText("zvažte opětovné odeslání");
    await expect(dialog(page)).toHaveCount(0);
    await nothingLeaves(page, smtp);
  });

  test("[MAIL-005] selhání je na faktuře vidět s důvodem", async ({ page, freshApp, smtp }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);
    smtp.rejectNext(550);
    await openDialog(page);
    await submit(page).click();
    await expect(page.getByTestId("send-problem")).toContainText("Odmítnuto 550", {
      timeout: 20_000,
    });
  });

  test("[MAIL-006] detail ukáže historii a archiv jde stáhnout", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    const detail = await issued(page, baseURL);
    await expect(page.getByText("Doklad zatím nikdo neodeslal.")).toBeVisible();
    await openDialog(page);
    await dialog(page).getByLabel("Předmět").fill("Archivní předmět");
    await submit(page).click();
    await delivered(page);

    await page.goto(detail);
    const history = page.getByTestId("email-history");
    await expect(history).toContainText(CLIENT);
    await expect(history).toContainText("Archivní předmět");
    const download = page.waitForEvent("download");
    await history.getByRole("link", { name: "Stáhnout odeslané PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  });

  test("hlavní vypínač ruční odeslání neblokuje a dialog to řekne", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await page.goto(`${baseURL}/nastaveni/automatizace`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Pozastavit vše" }).click();
    await expect(page.getByText("Automatika je pozastavená")).toBeVisible();

    await issued(page, baseURL);
    await openDialog(page);
    await expect(dialog(page)).toContainText("Hlavní vypínač automatiky je vypnutý");
    await submit(page).click();
    await delivered(page);
  });

  async function selectAll(page: Page, baseURL: string) {
    await page.goto(`${baseURL}/faktury`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Vybrat vše na stránce").check();
    await page.getByRole("button", { name: "Odeslat klientům" }).click();
  }

  test("[MAIL-008] souhrn příjemců ukáže přeskočené a vyžaduje potvrzení", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);
    await issued(page, baseURL);
    await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
    await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();

    await selectAll(page, baseURL);
    await expect(page.getByTestId("bulk-ready")).toContainText(CLIENT);
    await expect(page.getByTestId("bulk-ready").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("bulk-skipped")).toContainText("jen vystavená faktura");
    await nothingLeaves(page, smtp);

    await dialog(page).getByRole("button", { name: "Zpět" }).click();
    await nothingLeaves(page, smtp);
  });

  test("chyba náhledu hromadného odeslání se ukáže místo věčného načítání", async ({
    page,
    context,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    await issued(page, baseURL);
    await page.goto(`${baseURL}/faktury`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Vybrat vše na stránce").check();

    await context.clearCookies();
    await page.getByRole("button", { name: "Odeslat klientům" }).click();

    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await expect(dialog(page)).toContainText("Souhrn se nepodařilo připravit");
    await expect(dialog(page)).not.toContainText("Kontroluji doklady");
    await expect(dialog(page).getByRole("button", { name: /^Odeslat/ })).toBeDisabled();
  });

  test("[MAIL-008] [INV-024] hromadně z výběru odejdou 3 zprávy po potvrzení", async ({
    page,
    freshApp,
    smtp,
  }) => {
    const { baseURL } = freshApp;
    await connected(page, baseURL, smtp);
    for (let i = 0; i < 3; i += 1) await issued(page, baseURL);

    await selectAll(page, baseURL);
    await dialog(page).getByRole("button", { name: "Odeslat 3" }).click();
    await expect(page.getByRole("status")).toContainText("Zařazeno k odeslání 3");
    await expect.poll(() => smtp.messages.length, { timeout: 30_000 }).toBe(3);
  });
});

test("[SET-053] bez SMTP je tlačítko vypnuté s vysvětlením a PDF jde stáhnout", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await prepare(page, baseURL);
  const detail = await issued(page, baseURL);

  await expect(sendButton(page)).toBeDisabled();
  const hint = page.getByTestId("send-unavailable");
  await expect(hint).toContainText("Odesílání není dostupné");
  await expect(hint.getByRole("link", { name: "Nastavit poštu" })).toHaveAttribute(
    "href",
    "/nastaveni/posta",
  );
  expect((await page.request.get(`${detail}/pdf`)).status()).toBe(200);

  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Vybrat vše na stránce").check();
  await expect(page.getByRole("button", { name: "Odeslat klientům" })).toBeDisabled();
});
