import { expect, test } from "./fixtures";
import { cashInvoice, issue, openForm, ready, register, settled } from "./invoice-helpers";

test("[UI-010] [UI-008] Ctrl+K otevře hledání, šipka a Enter otevřou fakturu, Esc vrátí fokus", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  const invoiceUrl = page.url();

  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  const newInvoice = page.getByRole("link", { name: "Nová faktura" }).first();
  await newInvoice.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Rychlé hledání" });
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole("combobox", { name: "Hledat faktury, zákazníky, ceník a stránky" });
  await expect(box).toBeFocused();
  await expect(dialog.getByRole("status")).toHaveText("Napište aspoň 2 znaky.");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(newInvoice).toBeFocused();

  await page.keyboard.press("Control+k");
  await box.fill("alfa");
  const invoices = dialog.getByRole("group", { name: "Faktury" });
  await expect(invoices.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("group", { name: "Zákazníci" }).getByRole("option")).toHaveText(
    /Alfa s\.r\.o\./,
  );
  await page.keyboard.press("ArrowDown");
  const chosen = invoices.getByRole("option");
  await expect(chosen).toHaveAttribute("aria-selected", "true");
  await expect(box).toHaveAttribute("aria-activedescendant", (await chosen.getAttribute("id"))!);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(invoiceUrl);
  await expect(dialog).toBeHidden();
});

test("[UI-007] na telefonu se hledání otevře tlačítkem v hlavičce", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, baseURL);
  await page.getByRole("button", { name: "Rychlé hledání" }).click();
  const dialog = page.getByRole("dialog", { name: "Rychlé hledání" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("posta");
  await dialog
    .getByRole("group", { name: "Stránky" })
    .getByRole("option", { name: /Pošta/ })
    .click();
  await expect(page).toHaveURL(`${baseURL}/nastaveni/posta`);
});

test("[UI-010] Ctrl+K otevře hledání i z textového pole", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/zakaznici/novy`);
  await page.waitForLoadState("networkidle");
  const name = page.getByLabel("Název nebo jméno");
  await name.fill("Alfa");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Rychlé hledání" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Alfa");
});

test.describe("na Macu", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  test("[UI-010] [UI-008] ⌘K otevře hledání a Ctrl+K zůstane textovému poli", async ({
    page,
    freshApp,
  }) => {
    const { baseURL } = freshApp;
    await register(page, baseURL);
    await page.goto(`${baseURL}/zakaznici/novy`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Rychlé hledání" })).toContainText("⌘K");
    const name = page.getByLabel("Název nebo jméno");
    await name.fill("Alfa");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Rychlé hledání" });
    await expect(dialog).toBeHidden();
    await expect(name).toBeFocused();
    await page.keyboard.press("Meta+k");
    await expect(dialog).toBeVisible();
  });
});
