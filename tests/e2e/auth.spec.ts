import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";
const EMAIL = "prvni@example.cz";

test("[AUTH-001] první spuštění: registrace, přihlášení, odhlášení", async ({ page, freshApp }) => {
  await page.goto(`${freshApp.baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();

  await expect(page.getByText(EMAIL)).toBeVisible();
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page).toHaveURL(/\/prihlaseni$/);

  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Heslo").fill("spatne-heslo-spatne");
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(page.getByText("Nesprávný e-mail nebo heslo.")).toBeVisible();

  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await expect(page.getByText(EMAIL)).toBeVisible();

  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await expect(page).toHaveURL(/\/prihlaseni$/);
  await page.goto(`${freshApp.baseURL}/registrace`);
  await expect(page.getByText("Přístup je jen na pozvánku")).toBeVisible();
  await expect(page.getByRole("button", { name: "Vytvořit účet" })).toHaveCount(0);
});

test("[AUTH-001] dvě souběžné registrace přes HTTP založí jediný účet", async ({ freshApp }) => {
  const signUp = (email: string) =>
    fetch(`${freshApp.baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: freshApp.baseURL },
      body: JSON.stringify({ name: "Jan", email, password: PASSWORD }),
    });

  const results = await Promise.all([signUp("a@example.cz"), signUp("b@example.cz")]);

  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
});

test("[AUTH-005] odmítnuté sociální přihlášení ukáže obecnou hlášku", async ({
  page,
  freshApp,
}) => {
  await page.goto(`${freshApp.baseURL}/prihlaseni?chyba=pozvanka`);
  await expect(page.getByText("Přístup je jen na pozvánku")).toBeVisible();
});

test("[AUTH-004] bez klíčů se tlačítka poskytovatelů nezobrazí", async ({ page, freshApp }) => {
  await page.goto(`${freshApp.baseURL}/prihlaseni`);
  await expect(page.getByRole("button", { name: "Přihlásit se" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pokračovat přes/ })).toHaveCount(0);
});
