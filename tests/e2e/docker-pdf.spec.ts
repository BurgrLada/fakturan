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
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Jméno nebo firma").fill("Jan Novák");
  await page.getByLabel("Ulice a číslo").fill("Dlouhá 1");
  await page.getByLabel("Město").fill("Praha");
  await page.getByLabel("PSČ").fill("110 00");
  await page.getByLabel("IČO").fill("27082440");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByText("Uloženo.").first()).toBeVisible();
  await page
    .getByLabel("Logo na fakturu")
    .setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: FIXTURE_LOGO_SVG });
  await expect(page.getByRole("img", { name: "Logo na fakturu" })).toBeVisible();

  await page.goto(`${baseURL}/faktury/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("combobox", { name: "Zákazník" }).fill("Alfa s.r.o.");
  await page.getByRole("option", { name: "Založit zákazníka" }).click();
  await page.getByRole("button", { name: "Uložit zákazníka" }).click();
  await expect(page.getByRole("button", { name: "Uložit zákazníka" })).toBeHidden();
  await page.getByLabel("Způsob platby").selectOption("cash");
  await page.getByRole("combobox", { name: "Název položky" }).fill("Konzultace");
  await expect(page.getByText("Doklad je připravený k vystavení.")).toBeVisible();
  await page.getByRole("button", { name: "Vystavit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/]+$/);

  const response = await page.request.get(`${page.url()}/pdf`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const pdf = (await response.body()).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toContain("/Subtype /Image");
});
