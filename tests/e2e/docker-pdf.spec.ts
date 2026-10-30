import { FIXTURE_LOGO_SVG } from "../fixtures/invoices";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";

test.skip(!process.env.E2E_DOCKER_IMAGE, "Běží jen proti obrazu z E2E_DOCKER_IMAGE");

test("[PDF-001] standalone obraz vyrenderuje PDF s logem SVG", async ({ page, dockerApp }) => {
  const { baseURL } = dockerApp;
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();

  await page.goto(`${baseURL}/nastaveni/dodavatel`);
  await page.getByLabel("Jméno nebo firma").fill("Jan Novák");
  await page.getByLabel("Ulice a číslo").fill("Dlouhá 1");
  await page.getByLabel("Město").fill("Praha");
  await page.getByLabel("PSČ").fill("110 00");
  await page.getByLabel("IČO").fill("27082440");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await page
    .getByLabel("Logo")
    .setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: FIXTURE_LOGO_SVG });

  await page.goto(`${baseURL}/faktury/nova`);
  await page.getByLabel("Zákazník").fill("Alfa s.r.o.");
  await page.getByLabel("Název položky").fill("Konzultace");
  await page.getByRole("button", { name: "Vystavit" }).click();
  await page.getByRole("button", { name: "Vystavit" }).last().click();
  await page.waitForURL(/\/faktury\/[^/]+$/);

  const response = await page.request.get(`${page.url()}/pdf`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const pdf = (await response.body()).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toContain("/Subtype /Image");
});
