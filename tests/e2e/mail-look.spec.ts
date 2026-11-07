import { expect, test } from "./fixtures";
import { addSupplier, register } from "./invoice-helpers";

test("[MAIL-010] výběr vzhledu, náhled a vlastní podpis v Nastavení", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.getByRole("link", { name: "Vzhled e-mailu klientovi" }).click();
  await expect(page.getByRole("heading", { name: "Vzhled e-mailu", level: 1 })).toBeVisible();

  const b4 = page.getByRole("radio", { name: /B4 Tmavá hlavička/ });
  await expect(b4).toBeChecked();
  for (const name of ["B1", "B2", "B3", "B5", "A Dopis", "C Akcent"]) {
    await expect(page.getByRole("radio", { name: new RegExp(name) })).toBeVisible();
  }
  const preview = page.locator("iframe");
  await expect(preview).toHaveAttribute("sandbox", "");
  await expect(preview).toHaveAttribute("src", /layout=b4/);

  await page.getByRole("radio", { name: /B2 Karta s QR/ }).check();
  await expect(preview).toHaveAttribute("src", /layout=b2/);
  await page.getByLabel("Podpis pod textem zprávy").fill("Jana <b>Příkladová</b>");
  await page.getByRole("button", { name: "Uložit vzhled" }).click();
  await expect(page.getByRole("status")).toContainText("Vzhled e-mailu je uložený");

  const response = await page.request.get(`${baseURL}/nastaveni/posta/vzhled/nahled?layout=b2`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-security-policy"]).toBe(
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  );
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const html = await response.text();
  expect(html).toContain("Jana &lt;b&gt;Příkladová&lt;/b&gt;");
  expect(html).toContain('src="data:image/png;base64,');
  expect(
    (await page.request.get(`${baseURL}/nastaveni/posta/vzhled/nahled?layout=x`)).status(),
  ).toBe(400);

  await page.reload();
  await expect(page.getByRole("radio", { name: /B2 Karta s QR/ })).toBeChecked();
  await expect(page.getByLabel("Podpis pod textem zprávy")).toHaveValue("Jana <b>Příkladová</b>");
});
