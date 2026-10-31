import { pdfText } from "../helpers/pdf";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { FIXTURE_LOGO_SVG } from "../fixtures/invoices";
import { DOCKER_HOST_NAME, expect, test as base } from "./fixtures";
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
    // Every interface, because the container comes in through the Docker bridge.
    const server = await startSmtp("0.0.0.0");
    await use(server);
    await server.stop();
  },
});

test.skip(!process.env.E2E_DOCKER_IMAGE, "Běží jen proti obrazu z E2E_DOCKER_IMAGE");
test.setTimeout(150_000);
test.use({ allowPrivateMail: true });

test("[OPS-004] obraz: plánovač běží a health je ok", async ({ dockerApp }) => {
  const read = async () => {
    const res = await fetch(`${dockerApp.baseURL}/api/health`);
    return { code: res.status, body: await res.json() };
  };
  // Only croner moves "starting" to "running", so this proves it survived output tracing.
  await expect
    .poll(read, { timeout: 15_000 })
    .toEqual({ code: 200, body: { status: "ok", database: "ok", scheduler: "running" } });
});

test("[TST-005] obraz: zkušební zpráva i faktura s PDF projdou skutečným SMTP", async ({
  page,
  dockerApp,
  smtp,
}) => {
  const { baseURL } = dockerApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await page
    .getByLabel("Logo na fakturu")
    .setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: FIXTURE_LOGO_SVG });
  await expect(page.getByRole("img", { name: "Logo na fakturu" })).toBeVisible();
  await addCustomer(page, baseURL, CUSTOMER, CLIENT);

  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Server", { exact: true }).fill(DOCKER_HOST_NAME);
  await page.getByLabel("Port").fill(String(smtp.port));
  await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByRole("status")).toContainText("Nastavení pošty je uložené");
  await page.getByRole("button", { name: "Poslat zkušební e-mail" }).click();
  await smtp.waitFor("jan@example.cz");

  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Odeslat klientovi" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByLabel("Příjemci")).toHaveValue(CLIENT);
  await dialog.getByRole("button", { name: "Odeslat", exact: true }).click();

  await expect(page.getByTestId("email-history")).toContainText("Odesláno", { timeout: 20_000 });
  const message = await smtp.waitFor(CLIENT);
  const [attachment] = message.attachments;
  expect(attachment?.filename).toMatch(/\.pdf$/);
  const pdf = attachment!.content;
  // Decoding the text with diacritics fails if the fonts did not reach the image.
  expect((await pdfText(pdf)).join("\n")).toContain("Dlouhá 1");
  expect(pdf.toString("latin1")).toContain("/Subtype /Image");
});
