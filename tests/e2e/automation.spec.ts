import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PASSWORD = "správné-kůň-baterie-sponka";

async function register(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Jan Novák");
  await page.getByLabel("E-mail").fill("jan@example.cz");
  await page.getByLabel("Heslo").fill(PASSWORD);
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
}

const card = (page: Page, title: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });

test("[SET-040] stránka ukáže všechny 4 automatiky a jejich stav", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/automatizace`);
  await expect(page.getByRole("heading", { name: "Automatizace", level: 1 })).toBeVisible();

  await expect(
    page.getByRole("list", { name: "Seznam automatik" }).getByRole("listitem"),
  ).toHaveCount(4);
  await expect(card(page, "Pravidelné faktury: vystavit a odeslat")).toContainText("Vypnuto");
  await expect(card(page, "Upomínky po splatnosti")).toContainText("Vypnuto");
  await expect(card(page, "Potvrzení o přijaté platbě")).toContainText("Připravujeme");
  await expect(card(page, "Odeslání po záloze")).toContainText("Připravujeme");
  await expect(card(page, "Odeslání po záloze").getByRole("button")).toHaveCount(0);
});

test("[SET-042] dialog popíše, co a komu se pošle", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");
  const reminders = card(page, "Upomínky po splatnosti");

  await reminders.getByRole("button", { name: "Zapnout" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(
    "Zákazníkům s fakturou po splatnosti odejde upomínka e-mailem",
  );
  await expect(dialog).toContainText("Upomínky mohou dostat zákazníci: 0.");
  await dialog.getByRole("button", { name: "Zpět" }).click();
  await expect(reminders).toContainText("Vypnuto");

  await reminders.getByRole("button", { name: "Zapnout" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Zapnout a potvrdit" }).click();
  await expect(reminders).toContainText("Zapnuto");

  await page.reload();
  await expect(card(page, "Upomínky po splatnosti")).toContainText("Zapnuto");
});

test("[SET-043] hlavní vypínač se obnovuje až po potvrzení", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Pozastavit vše" }).click();
  await expect(page.getByText("Automatika je pozastavená")).toBeVisible();

  await page.getByRole("button", { name: "Obnovit" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Nic, co se za dobu pozastavení zadrželo, se samo neodešle.",
  );
  await page.getByRole("alertdialog").getByRole("button", { name: "Obnovit" }).click();
  await expect(page.getByText("Automatika běží")).toBeVisible();
});

test("[UI-009] stránka upozornění bez dat ukáže prázdný stav a zvonek bez počtu", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);

  await page.getByRole("link", { name: "Upozornění, nepřečtených: 0" }).first().click();

  await expect(page).toHaveURL(/\/upozorneni$/);
  await expect(page.getByRole("heading", { name: "Žádná upozornění" })).toBeVisible();
});

test("[SET-042] chybu hlásí role alert, úspěch role status", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");
  const time = page.getByLabel("Čas", { exact: true });

  // The browser would refuse this value, and the server check is what is under test. The component
  // state keeps it even though React restores the time type, hence no form validation either.
  await time.evaluate((input: HTMLInputElement) => {
    input.form!.noValidate = true;
    input.type = "text";
    const { set } = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    set!.call(input, "99:99");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Uložit čas" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "čas" })).toBeVisible();

  await time.fill("08:30");
  await page.getByRole("button", { name: "Uložit čas" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Uloženo." })).toBeVisible();
});
