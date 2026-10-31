import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "./fixtures";
import {
  PASSWORD,
  CUSTOMER,
  register,
  addCatalogItem,
  openForm,
  chooseCustomer,
  settled,
  fillLine,
  issue,
  issuedPdf,
  draftPdf,
  invite,
  ready,
  cashInvoice,
} from "./invoice-helpers";

test("[INV-010] vyberu zákazníka, položku z ceníku a vystavím", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await addCatalogItem(page, baseURL, "Vývoj webu");

  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová faktura" }).first().click();
  await page.waitForURL(/upravit$/);
  await page.waitForLoadState("networkidle");

  await expect(page.getByLabel("Datum vystavení")).not.toHaveValue("");
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await page.getByRole("combobox", { name: "Název položky" }).fill("Vývoj");
  await page.getByRole("option", { name: /Vývoj webu/ }).click();
  await expect(page.getByLabel("Cena za jednotku")).toHaveValue("1500,00");
  await expect(page.getByLabel("Jednotka")).toHaveValue("hod.");
  await expect(page.getByTestId("invoice-total")).toContainText("1 500,00");
  await settled(page);
  await expect(page.getByText("Doklad je připravený k vystavení.")).toBeVisible();

  await page.getByRole("button", { name: "Vystavit" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(/Číslo faktury: \S+/)).toBeVisible();
  await dialog.getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/]+$/);

  await expect(page.getByRole("heading", { name: /Faktura \S+/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Odeslat klientovi" })).toBeDisabled();
  await expect(page.getByText("Odesílání není dostupné")).toBeVisible();
  const pdf = await issuedPdf(page);
  expect(pdf).toContain("Vývoj webu");
  expect(pdf).toContain(CUSTOMER);
});

test("[INV-010] souhrn ukáže chybějící dodavatele s odkazem a změna zákazníka nepřepíše ruční pole", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/zakaznici/novy`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název nebo jméno").fill(CUSTOMER);
  await page.getByLabel("Splatnost ve dnech").fill("30");
  await page.getByLabel("Jazyk faktury").selectOption("en");
  await page.getByRole("button", { name: "Uložit" }).click();
  await expect(page.getByRole("heading", { name: "Karta zákazníka" })).toBeVisible();

  await openForm(page, baseURL);
  await expect(page.getByTestId("save-status")).toHaveText("Koncept vznikne první změnou.");
  await page.getByLabel("Datum splatnosti").fill("2030-01-15");
  await chooseCustomer(page);
  await expect(page.getByLabel("Jazyk faktury")).toHaveValue("en");
  await expect(page.getByLabel("Datum splatnosti")).toHaveValue("2030-01-15");
  await settled(page);

  const link = page.getByRole("link", { name: /Doplňte u dodavatele/ }).first();
  await expect(link).toHaveAttribute("href", "/nastaveni/dodavatel");
});

test("[INV-010] datum mimo aktuální měsíc se v dialogu opraví jedním kliknutím", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByLabel("Datum vystavení").fill("2020-01-15");
  await settled(page);

  await page.getByRole("button", { name: "Vystavit" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("není v aktuálním měsíci")).toBeVisible();
  await expect(dialog.getByText(/Číslo faktury: 2020/)).toBeVisible();

  await dialog.getByRole("button", { name: "Použít dnešní datum" }).click();
  await expect(dialog.getByText("není v aktuálním měsíci")).toBeHidden();
  await expect(dialog.getByText(/Číslo faktury: 2020/)).toBeHidden();
  await dialog.getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/]+$/);
});

test("[NUM-007] variabilní symbol se v dialogu předvyplní a jde přepsat", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);

  await page.getByRole("button", { name: "Vystavit" }).click();
  const symbol = page.getByRole("alertdialog").getByLabel("Variabilní symbol");
  await expect(symbol).toHaveValue(/^\d+$/);
  await symbol.fill("778899");
  await page.getByRole("alertdialog").getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/]+$/);

  expect(await issuedPdf(page)).toContain("778899");
});

test("[NUM-007] vymazaný VS v dialogu nepoužije automatický a dialog to řekne", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);

  await page.getByRole("button", { name: "Vystavit" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Variabilní symbol").fill("");
  await expect(dialog).toContainText("bez variabilního symbolu");
  await dialog.getByRole("button", { name: "Vystavit" }).click();
  await page.waitForURL(/\/faktury\/[^/]+$/);

  expect(await issuedPdf(page)).not.toContain("Variabilní symbol");
});

test("[NUM-007] VS vystaveného dokladu jde opravit a po změně čísla se ukáže nový", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  const detail = page.url();
  await page.goto(`${detail}/upravit`);
  await page.waitForLoadState("networkidle");
  const symbol = page.getByLabel("Variabilní symbol");

  await page.getByLabel("Číslo faktury").fill("2030-777");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Změny jsou uložené.")).toBeVisible();
  await expect(symbol).toHaveValue("2030777");

  await symbol.fill("12ab");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Variabilní symbol smí mít jen číslice")).toBeVisible();

  await symbol.fill("4242");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Změny jsou uložené.")).toBeVisible();

  await page.goto(detail);
  expect(await issuedPdf(page)).toContain("4242");
  await expect(page.getByRole("link", { name: "Verze 2" })).toBeVisible();
});

test("[INV-014] sleva vyšší než základ se ve formuláři i dialogu ohlásí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByLabel("Sleva na doklad").selectOption("amount");
  await page.getByLabel("Výše slevy na doklad").fill("5000");

  const note = "Sleva na doklad je vyšší než základ";
  await expect(page.getByTestId("discount-notes")).toContainText(note);
  await settled(page);
  await page.getByRole("button", { name: "Vystavit" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(note);
});

test("[NUM-003] řada zvolená ve formuláři se projeví v čísle", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await page.reload();

  await page.goto(`${baseURL}/nastaveni/rady`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název řady").fill("Druhá");
  await page.getByLabel("Formát").selectOption({ label: "Vlastní" });
  await page.getByLabel("Šablona").fill("B{RRRR}-{NNN}");
  await page.getByRole("button", { name: "Uložit řadu" }).click();
  await expect(page.getByText("Řada je uložená.")).toBeVisible();

  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByLabel("Číselná řada").selectOption({ label: "Druhá" });
  await settled(page);
  await issue(page);

  await expect(page.getByRole("heading", { name: /Faktura B\d{4}-001/ })).toBeVisible();
});

test("[INV-010] výběr zákazníka u uloženého konceptu nic tiše nepřepíše", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Měna").selectOption("EUR");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "1000");
  await settled(page);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await chooseCustomer(page);
  await settled(page);

  await expect(page.getByLabel("Měna")).toHaveValue("EUR");
  await expect(page.getByLabel("Způsob platby")).toHaveValue("cash");
});

test("[INV-011] zákazník založený ve formuláři je vybraný", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);

  await page.getByRole("combobox", { name: "Zákazník" }).fill("Nový klient");
  await page.getByRole("option", { name: "Založit zákazníka „Nový klient“" }).click();
  await expect(page.getByLabel("Název nebo jméno")).toHaveValue("Nový klient");
  await page.getByLabel("Město").fill("Brno");
  await page.getByRole("button", { name: "Uložit zákazníka" }).click();

  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveValue("Nový klient");
  await expect(page.getByRole("button", { name: "Uložit zákazníka" })).toBeHidden();
  await settled(page);
  await expect(page.getByText("Vyberte zákazníka")).toBeHidden();

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveValue("Nový klient");
});

test("[INV-012] položky lze přeřadit myší i klávesnicí", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await page.setViewportSize({ width: 1280, height: 1600 });
  await register(page, baseURL);
  await openForm(page, baseURL);
  await fillLine(page, 0, "První", "1");
  await page.getByRole("button", { name: "Přidat položku" }).click();
  await fillLine(page, 1, "Druhá", "2");
  await page.getByRole("button", { name: "Přidat položku" }).click();
  await fillLine(page, 2, "Třetí", "3");
  const names = page.getByRole("combobox", { name: "Název položky" });

  const handle = page.getByRole("button", { name: "Přesunout položku 1" });
  await handle.focus();
  await page.keyboard.press("Space");
  // dnd-kit starts listening for arrows only after the drag has begun.
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await expect(names.nth(0)).toHaveValue("Druhá");
  await expect(names.nth(1)).toHaveValue("První");

  const grip = page.getByRole("button", { name: "Přesunout položku 3" });
  await grip.scrollIntoViewIfNeeded();
  const from = await grip.boundingBox();
  const to = await page.getByTestId("invoice-line").nth(1).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x, from!.y - 20, { steps: 5 });
  await page.mouse.move(to!.x + 20, to!.y + 10, { steps: 15 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await expect(names.nth(1)).toHaveValue("Třetí");

  await settled(page);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Název položky" }).nth(0)).toHaveValue("Druhá");
  await expect(page.getByRole("combobox", { name: "Název položky" }).nth(1)).toHaveValue("Třetí");
  await expect(page.getByRole("combobox", { name: "Název položky" }).nth(2)).toHaveValue("První");
});

test("[INV-012] prázdný řádek uprostřed vystavení nezablokuje", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByRole("button", { name: "Přidat položku" }).click();
  await settled(page);

  await issue(page);
  await expect(page.getByRole("heading", { name: /Faktura \S+/ })).toBeVisible();
});

test("[INV-013] řádek jde uložit do ceníku", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addCatalogItem(page, baseURL, "Eurová služba", "EUR");
  await openForm(page, baseURL);

  await fillLine(page, 0, "Audit webu", "2500");
  await page.getByRole("button", { name: "Uložit do ceníku" }).click();
  await expect(page.getByText("Uloženo v ceníku")).toBeVisible();

  await page.getByRole("button", { name: "Přidat položku" }).click();
  const second = page.getByRole("combobox", { name: "Název položky" }).nth(1);
  await second.fill("Audit");
  await expect(page.getByRole("option", { name: /Audit webu/ })).toBeVisible();

  await second.fill("Eurová");
  await page.getByRole("option", { name: /Eurová služba/ }).click();
  await expect(page.getByLabel("Cena za jednotku").nth(1)).toHaveValue("1500,00");
  await expect(page.getByText("Cena v ceníku je v EUR, faktura je v CZK")).toBeVisible();

  await page.goto(`${baseURL}/cenik`);
  await expect(page.getByRole("link", { name: "Audit webu" })).toBeVisible();
});

test("[INV-014] sleva na doklad se promítne do součtu a PDF", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByLabel("Sleva na doklad").selectOption("percent");
  await page.getByLabel("Výše slevy na doklad").fill("10");

  await expect(page.getByTestId("invoice-total")).toContainText("900,00");
  await settled(page);
  await issue(page);

  expect(await issuedPdf(page)).toMatch(/900,00/);
});

test("[INV-015] zaokrouhlení na koruny", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "100,50");
  await page.getByLabel("Zaokrouhlení celkové částky").selectOption("whole");

  await expect(page.getByTestId("invoice-total")).toContainText("101,00");
  await expect(page.getByTestId("invoice-totals")).toContainText("0,50");
  await settled(page);
  await issue(page);

  expect(await issuedPdf(page)).toMatch(/101,00/);
});

test("[INV-016] náhled se změní po úpravě", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await expect(page.getByTitle("Náhled faktury")).toHaveCount(0);

  await fillLine(page, 0, "Původní položka", "100");
  const preview = page.getByTitle("Náhled faktury");
  await expect(preview).toHaveAttribute("src", /\/nahled\?rev=\d+/);
  const first = await preview.getAttribute("src");
  expect(await draftPdf(page)).toContain("Původní položka");

  await page.getByRole("combobox", { name: "Název položky" }).fill("Nová položka");
  await expect(preview).not.toHaveAttribute("src", first!);
  expect(await draftPdf(page)).toContain("Nová položka");
});

test("[INV-017] po znovunačtení je koncept zachovaný", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);

  await fillLine(page, 0, "Rozdělaná práce", "123,45");
  await expect(page).toHaveURL(/\/faktury\/[\w-]+\/upravit$/);
  await settled(page);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Název položky" })).toHaveValue(
    "Rozdělaná práce",
  );
  await expect(page.getByLabel("Cena za jednotku")).toHaveValue("123,45");
});

test("[INV-017] nová stránka bez změny koncept nezaloží", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);

  await page.getByRole("button", { name: "Přidat položku" }).click();
  await page.waitForTimeout(2000);

  await expect(page.getByTestId("save-status")).toHaveText("Koncept vznikne první změnou.");
  await page.reload();
  await expect(page.getByTestId("save-status")).toHaveText("Koncept vznikne první změnou.");
});

test("[INV-017] druhá karta dostane srozumitelné odmítnutí", async ({
  page,
  context,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await fillLine(page, 0, "Sdílený koncept", "100");
  await expect(page).toHaveURL(/upravit$/);
  await settled(page);

  const second = await context.newPage();
  await second.goto(page.url());
  await second.waitForLoadState("networkidle");

  await page.getByLabel("Poznámka").fill("z první karty");
  await settled(page);
  await second.getByLabel("Poznámka").fill("z druhé karty");

  await expect(second.getByRole("alert").getByText("Doklad se mezitím změnil.")).toBeVisible();
  await expect(second.getByLabel("Poznámka")).toBeDisabled();
  await second.getByRole("link", { name: "Obnovit stránku" }).click();
  await expect(second.getByLabel("Poznámka")).toHaveValue("z první karty");
});

test("[INV-017] výpadek odpovědi nezamkne formulář a nezaloží druhý koncept", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);

  let lost = 0;
  await page.route(/\/(nova|upravit)$/, async (route) => {
    if (route.request().method() !== "POST" || lost > 0) return route.fallback();
    lost += 1;
    await route.fetch();
    await route.abort();
  });

  await fillLine(page, 0, "Jednou", "100");
  await expect(page.getByTestId("save-status")).toHaveText(/zkouším to znovu/);
  await expect(page.getByTestId("save-status")).toHaveText("Uloženo", { timeout: 10_000 });
  await expect(page).toHaveURL(/upravit$/);
  await expect(page.getByText("Doklad se mezitím změnil.")).toHaveCount(0);
  await expect(page.getByTitle("Náhled faktury")).toHaveAttribute("src", /rev=1$/);
});

test("[INV-019] volitelná pole se propíšou do PDF", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await page.getByLabel("DUZP (nepovinné)").fill("2026-02-03");
  await page.getByLabel("Číslo objednávky").fill("OBJ-77");
  await page.getByLabel("Reference", { exact: true }).fill("Zakázka Vltava");
  await page.getByLabel("Text před položkami").fill("Fakturujeme práce.");
  await page.getByLabel("Text za položkami").fill("Děkujeme za spolupráci.");
  await settled(page);
  await issue(page);

  const pdf = await issuedPdf(page);
  for (const text of [
    "OBJ-77",
    "Zakázka Vltava",
    "Fakturujeme práce.",
    "Děkujeme za spolupráci.",
    "3. 2. 2026",
  ]) {
    expect(pdf).toContain(text);
  }
});

test("[FOR-002] měna jde zvolit a cizí měna ukáže ruční kurz", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await expect(page.getByLabel("Kurz k CZK")).toHaveCount(0);
  await expect(page.getByLabel("Měna").locator("option")).toHaveText([
    "CZK",
    "EUR",
    "USD",
    "GBP",
    "CHF",
    "PLN",
  ]);

  await chooseCustomer(page);
  await page.getByLabel("Způsob platby").selectOption("cash");
  await fillLine(page, 0, "Konzultace", "100");
  await page.getByLabel("Měna").selectOption("EUR");
  await settled(page);
  await expect(page.getByRole("link", { name: "Vyplňte kurz EUR" })).toHaveAttribute(
    "href",
    "#field-exchangeRate",
  );

  await page.getByLabel("Kurz k CZK").fill("24,5");
  await settled(page);
  await expect(page.getByRole("link", { name: "Vyplňte kurz EUR" })).toBeHidden();
  await issue(page);
  expect(await issuedPdf(page)).toContain("100,00 €");
});

test("[INV-020] úprava odeslané faktury upozorní", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  const detail = page.url();

  await page.getByRole("link", { name: "Upravit" }).click();
  await page.waitForURL(/upravit$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("už byla odeslaná")).toBeHidden();
  await expect(page.getByTestId("save-status")).toHaveCount(0);
  const number = await page.getByLabel("Číslo faktury").inputValue();
  await page.getByLabel("Poznámka").fill("Opraveno");
  await page.waitForTimeout(2000);
  await page.reload();
  await expect(page.getByLabel("Poznámka")).toHaveValue("");

  await page.getByLabel("Číslo faktury").fill(`${number}-A`);
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("Změny jsou uložené.")).toBeVisible();
  await expect(page.getByText("zvažte opětovné odeslání")).toBeHidden();

  await page.goto(detail);
  await page.getByRole("button", { name: "Označit jako odeslanou" }).click();
  await expect(page.getByText("Odeslaná", { exact: true })).toBeVisible();
  await page.goto(`${detail}/upravit`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("už byla odeslaná")).toBeVisible();
  await page.getByLabel("Poznámka").fill("Znovu");
  await page.getByRole("button", { name: "Uložit změny" }).click();
  await expect(page.getByText("zvažte opětovné odeslání")).toBeVisible();

  await page.goto(detail);
  await expect(page.getByRole("heading", { name: `Faktura ${number}-A` })).toBeVisible();
});

test("[INV-025] celý formulář jde dokončit klávesnicí", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);

  const customer = page.getByRole("combobox", { name: "Zákazník" });
  await customer.focus();
  await page.keyboard.type("Alf");
  await expect(page.getByRole("option", { name: new RegExp(CUSTOMER) })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(customer).toHaveValue(CUSTOMER);

  const method = page.getByLabel("Způsob platby");
  while (!(await method.evaluate((el) => el === document.activeElement))) {
    await page.keyboard.press("Tab");
  }
  await page.keyboard.type("Hotově");
  await expect(method).toHaveValue("cash");

  const name = page.getByRole("combobox", { name: "Název položky" });
  while (!(await name.evaluate((el) => el === document.activeElement))) {
    await page.keyboard.press("Tab");
  }
  await page.keyboard.type("Konzultace");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Cena za jednotku")).toBeFocused();
  await page.keyboard.type("1000");
  await settled(page);

  await page.keyboard.press("Enter");
  const symbol = page.getByRole("alertdialog").getByLabel("Variabilní symbol");
  await expect(symbol).toBeVisible();
  await symbol.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/faktury\/[^/]+$/);
});

test("[INV-026] bez štítků je PDF stejné, štítek jde založit ve formuláři", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await expect(page).toHaveURL(/upravit$/);
  const before = await draftPdf(page);

  await page.getByLabel("Přidat štítek").fill("Marketing");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Odebrat štítek Marketing" })).toBeVisible();
  await settled(page);

  await page.reload();
  await expect(page.getByRole("button", { name: "Odebrat štítek Marketing" })).toBeVisible();
  const after = await draftPdf(page);
  expect(after).toBe(before);
  expect(after).not.toContain("Marketing");
});

test("[INV-017] založení zákazníka ve formuláři zachová rozepsaná data bez odmítnutí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Poznámka").fill("první");
  await settled(page);
  await page.getByLabel("Poznámka").fill("druhá");

  await page.getByRole("combobox", { name: "Zákazník" }).fill("Nový klient");
  await page.getByRole("option", { name: "Založit zákazníka „Nový klient“" }).click();
  await page.getByRole("button", { name: "Uložit zákazníka" }).click();
  await expect(page.getByRole("button", { name: "Uložit zákazníka" })).toBeHidden();

  await expect(page.getByLabel("Poznámka")).toHaveValue("druhá");
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveValue("Nový klient");
  await page.getByLabel("Poznámka").fill("třetí");
  await settled(page);
  await expect(page.getByText("Doklad se mezitím změnil.")).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("Poznámka")).toHaveValue("třetí");
  await expect(page.getByRole("combobox", { name: "Zákazník" })).toHaveValue("Nový klient");
});

test("[INV-017] adresa i strom sedí po prvním uložení a Zpět nevyvolá odmítnutí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/faktury`);
  await page.getByRole("link", { name: "Nová faktura" }).first().click();
  await page.waitForURL(/upravit$/);
  await page.waitForLoadState("networkidle");
  const url = page.url();
  await page.getByLabel("Poznámka").fill("před odchodem");
  await settled(page);
  expect(page.url()).toBe(url);

  await page.goBack();
  await expect(page).toHaveURL(/\/faktury$/);
  await page.goForward();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel("Poznámka")).toHaveValue("před odchodem");
  await page.getByLabel("Poznámka").fill("po návratu");
  await settled(page);
  await expect(page.getByText("Doklad se mezitím změnil.")).toHaveCount(0);
});

test("[INV-017] odchod během čekání na uložení nepřepíše adresu cizí stránky", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);

  await page.getByLabel("Poznámka").fill("rozepsané");
  await page.getByRole("link", { name: "Ceník" }).click();
  await page.waitForURL(/\/cenik$/);
  await page.waitForTimeout(2500);

  await expect(page).toHaveURL(/\/cenik$/);
  await page.goBack();
  await expect(page.getByLabel("Poznámka")).toHaveValue("rozepsané");
});

test("[INV-017] neplatný formulář varuje před odchodem uvnitř aplikace", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await fillLine(page, 0, "Práce", "abc");
  await expect(page.getByTestId("save-status")).toContainText("Opravte");

  const answers = [false, true];
  page.on("dialog", (dialog) => (answers.shift() ? dialog.accept() : dialog.dismiss()));
  await page.getByRole("link", { name: "Ceník" }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/upravit$/);

  await page.getByRole("link", { name: "Ceník" }).click();
  await page.waitForURL(/\/cenik$/);
  expect(answers).toEqual([]);
});

test("[INV-017] obsah odmítnutý serverem varuje a Vystavit řekne proč nic neudělá", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Reference", { exact: true }).fill("x".repeat(201));
  await expect(page.getByTestId("save-status")).toHaveText("Text je příliš dlouhý");

  await page.getByRole("button", { name: "Vystavit" }).click();
  await expect(page.getByText("Změny se nepodařilo uložit")).toBeVisible();

  let asked = 0;
  page.on("dialog", (dialog) => {
    asked += 1;
    return dialog.dismiss();
  });
  await page.getByRole("link", { name: "Ceník" }).click();
  await page.waitForTimeout(500);
  expect(asked).toBe(1);
  await expect(page).toHaveURL(/upravit$/);
});

test("[INV-020] neuložená úprava vystavené faktury varuje před odchodem", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await issue(page);
  await page.goto(`${page.url()}/upravit`);
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Poznámka").fill("neuloženo");
  let asked = 0;
  page.on("dialog", (dialog) => {
    asked += 1;
    return dialog.dismiss();
  });
  await page.getByRole("link", { name: "Ceník" }).click();
  await page.waitForTimeout(500);
  expect(asked).toBe(1);
  await expect(page).toHaveURL(/upravit$/);
});

test("[INV-017] vypršená relace při ukládání vede na přihlášení", async ({ page, freshApp }) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Poznámka").fill("před vypršením");
  await settled(page);

  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite.prepare("DELETE FROM session").run();
  sqlite.close();

  await page.getByLabel("Poznámka").fill("po vypršení");
  await expect(page.getByRole("link", { name: "Přihlásit se" })).toBeVisible();
  await expect(page.getByText("zkouším to znovu")).toHaveCount(0);
});

test("[SET-030] vzhled konkrétní faktury jde změnit ve sbalené sekci", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await openForm(page, baseURL);
  await cashInvoice(page);
  await expect(page.getByLabel("Design")).toBeHidden();

  await page.getByText("Vzhled dokladu").click();
  await page.getByLabel("Design").selectOption({ label: "Mono" });
  await page.getByLabel("Akcent").fill("#123456");
  await page.getByLabel("Umístění loga").selectOption("right");
  await page.getByLabel("Zobrazit QR platbu").uncheck();
  await settled(page);

  await page.reload();
  await page.getByText("Vzhled dokladu").click();
  await expect(page.getByLabel("Design")).toHaveValue("mono");
  await expect(page.getByLabel("Akcent")).toHaveValue("#123456");
  await expect(page.getByLabel("Umístění loga")).toHaveValue("right");
  await expect(page.getByLabel("Zobrazit QR platbu")).not.toBeChecked();
});

test("[SET-031] Vystavit u neplatné barvy otevře sbalenou sekci a dá na pole focus", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByText("Vzhled dokladu").click();
  await page.getByLabel("Akcent").fill("modrá");
  await page.getByText("Vzhled dokladu").click();
  await expect(page.getByLabel("Akcent")).toBeHidden();

  await page.getByRole("button", { name: "Vystavit" }).click();
  await expect(page.getByLabel("Akcent")).toBeVisible();
  await expect(page.getByLabel("Akcent")).toBeFocused();
});

test("[SET-031] neplatná barva dokladu se neuloží a je zvýrazněná", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByText("Vzhled dokladu").click();
  await page.getByLabel("Akcent").fill("modrá");

  await expect(page.getByLabel("Akcent")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("save-status")).toContainText("Opravte");
});

test("[INV-013] uložení do ceníku nepřepíše psaný text a odmítne neplatnou cenu", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await fillLine(page, 0, "Audit", "abc");
  await page.getByRole("button", { name: "Uložit do ceníku" }).click();
  await expect(page.getByText("Zadejte platnou cenu")).toBeVisible();
  await expect(page.getByText("Uloženo v ceníku")).toHaveCount(0);

  await page.getByLabel("Cena za jednotku").fill("100");
  await settled(page);
  await page.route(/\/upravit$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return route.fallback();
  });
  await page.getByRole("button", { name: "Uložit do ceníku" }).click();
  await expect(page.getByRole("button", { name: "Ukládám…" })).toBeDisabled();
  await page.getByLabel("Popis položky").fill("psáno během ukládání");
  await expect(page.getByText("Uloženo v ceníku")).toBeVisible();
  await expect(page.getByLabel("Popis položky")).toHaveValue("psáno během ukládání");

  await page.goto(`${baseURL}/cenik`);
  await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();
});

test("[INV-013] prázdná cena se do ceníku neuloží jako nula", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByRole("combobox", { name: "Název položky" }).fill("Bez ceny");
  await page.getByRole("button", { name: "Uložit do ceníku" }).click();
  await expect(page.getByText("Zadejte platnou cenu")).toBeVisible();
  await expect(page.getByText("Uloženo v ceníku")).toHaveCount(0);

  await page.goto(`${baseURL}/cenik`);
  await expect(page.getByRole("link", { name: "Bez ceny" })).toHaveCount(0);
});

test("[INV-017] odhlášení u neplatného formuláře nejdřív varuje", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByText("Vzhled dokladu").click();
  await page.getByLabel("Akcent").fill("modrá");
  const form = page.url();

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(form);
  await expect(page.getByLabel("Akcent")).toHaveValue("modrá");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await page.waitForURL(/\/prihlaseni/);
});

test("[INV-017] odhlášení během čekání na uložení změnu nejdřív uloží", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Poznámka").fill("před odhlášením");
  await page.getByRole("button", { name: "Odhlásit se" }).click();
  await page.waitForURL(/\/prihlaseni/);

  const sqlite = new Database(join(dataDir, "fakturan.db"), { readonly: true });
  const notes = sqlite.prepare("SELECT note FROM invoice").pluck().all();
  sqlite.close();
  expect(notes).toEqual(["před odhlášením"]);
});

test("[INV-017] skrytý předchozí formulář nedrží stejná id", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  // Sampled on every mutation, because a stale copy may disappear before an assertion polls.
  await page.addInitScript(() => {
    const store = window as unknown as { maxForms: number };
    store.maxForms = 0;
    const sample = () => {
      const count = document.querySelectorAll('[id="field-note"]').length;
      store.maxForms = Math.max(store.maxForms, count);
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");

  for (const note of ["první", "druhá"]) {
    await page.getByRole("link", { name: "Nová faktura" }).first().click();
    await page.waitForURL(/upravit$/);
    await expect(page.getByLabel("Poznámka")).toHaveValue("");
    await page.getByLabel("Poznámka").fill(note);
    await settled(page);
    await page.getByRole("link", { name: "Zpět na faktury" }).click();
    await page.waitForURL(/\/faktury$/);
    await expect(page.locator('[id="field-note"]')).toHaveCount(0);
  }

  await page.goBack();
  await expect(page.getByLabel("Poznámka")).toHaveValue("druhá");

  // No screen links two forms directly yet, but the router may swap them without a page between.
  await page.evaluate(() => {
    const { next } = window as unknown as { next: { router: { push(href: string): void } } };
    next.router.push("/faktury/nova");
  });
  await page.waitForFunction(() => {
    const note = document.querySelector<HTMLTextAreaElement>('[id="field-note"]');
    return note?.checkVisibility() && note.value === "";
  });
  await expect(page.getByLabel("Poznámka")).toHaveValue("");
  await expect(page.locator('[id="field-note"]')).toHaveCount(1);
  const most = await page.evaluate(() => (window as unknown as { maxForms: number }).maxForms);
  expect(most).toBe(1);
});

test("[INV-017] vypršená relace v panelu zákazníka nezahodí formulář", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Poznámka").fill("rozepsáno");
  await settled(page);
  const form = page.url();

  await page.getByRole("combobox", { name: "Zákazník" }).fill("Nový klient");
  await page.getByRole("option", { name: "Založit zákazníka „Nový klient“" }).click();
  await expect(page.getByRole("button", { name: "Uložit zákazníka" })).toBeVisible();
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  sqlite.prepare("DELETE FROM session").run();
  sqlite.close();

  await page.getByRole("button", { name: "Uložit zákazníka" }).click();
  await expect(page.getByRole("link", { name: "Přihlásit se" })).toBeVisible();
  expect(page.url()).toBe(form);
  await expect(page.getByLabel("Poznámka")).toHaveValue("rozepsáno");
});

test("[SEC-002] cizí nebo neznámý doklad vrátí 404", async ({ page, browser, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await openForm(page, baseURL);
  await page.getByLabel("Poznámka").fill("moje");
  await settled(page);
  const foreign = page.url();
  const url = await invite(page, "host@example.cz", baseURL);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(url);
  await guest.getByRole("button", { name: "Pokračovat k registraci" }).click();
  await guest.getByLabel("Jméno").fill("Host");
  await guest.getByLabel("Heslo").fill(PASSWORD);
  await guest.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(guest.getByText("host@example.cz", { exact: true })).toBeVisible();

  const form = await guest.goto(foreign);
  expect(form?.status()).toBe(404);
  const detail = await guest.goto(foreign.replace(/\/upravit$/, ""));
  expect(detail?.status()).toBe(404);
  const unknown = await guest.goto(`${baseURL}/faktury/neexistuje/upravit`);
  expect(unknown?.status()).toBe(404);
  const create = await guest.goto(`${baseURL}/faktury/nova`);
  expect(create?.status()).toBe(200);
  await expect(guest).toHaveURL(/upravit$/);
  await context.close();
});
