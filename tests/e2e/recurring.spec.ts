import { join } from "node:path";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  addCustomer,
  addSupplier,
  cashInvoice,
  CUSTOMER,
  fillLine,
  issuedPdf,
  openForm,
  ready,
  register,
  settled,
} from "./invoice-helpers";
import { startSmtp, type TestSmtp } from "../helpers/smtp";
import { expect, test } from "./fixtures";

const prague = (offsetMonths = 0) => {
  const [year, month] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" })
    .format(new Date())
    .split("-")
    .map(Number);
  const index = year! * 12 + month! - 1 + offsetMonths;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

async function setSendTime(page: Page, baseURL: string, time: string) {
  await page.goto(`${baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Čas", { exact: true }).fill(time);
  await page.getByRole("button", { name: "Uložit čas" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Uloženo." })).toBeVisible();
}

const automation = (page: Page) =>
  page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Pravidelné faktury: vystavit a odeslat" }),
  });

async function enableRecurringSend(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");
  await automation(page).getByRole("button", { name: "Zapnout" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Zapnout a potvrdit" }).click();
  await expect(automation(page)).toContainText("Zapnuto");
}

async function createPlan(page: Page, baseURL: string, name: string) {
  await page.goto(`${baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill(name);
  await fillLine(page, 0, "Správa webu", "1000");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  return page.url();
}

// A cash template keeps the plan issuable without a bank account.
async function planFromTemplate(page: Page, baseURL: string, name: string) {
  await openForm(page, baseURL);
  await cashInvoice(page);
  await settled(page);
  await page.getByRole("button", { name: "Uložit jako šablonu" }).click();
  await page.getByRole("alertdialog").getByLabel("Název šablony").fill(name);
  await page.getByRole("alertdialog").getByRole("button", { name: "Uložit šablonu" }).click();
  await expect(page.getByText("Šablona je uložená.")).toBeVisible();
  await page.goto(`${baseURL}/faktury/sablony`);
  await page.getByRole("button", { name: `Vytvořit pravidelnou: ${name}` }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  return page.url();
}

async function waitForRun(page: Page, plan: string) {
  await expect(async () => {
    await page.goto(plan);
    await expect(page.getByTestId("run-row")).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
}

test("[REC-004] detail plánu má v titulku jeho název", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await addSupplier(page, freshApp.baseURL);
  await addCustomer(page, freshApp.baseURL);
  await planFromTemplate(page, freshApp.baseURL, "Správa webu");
  await expect(page).toHaveTitle("Správa webu | Fakturan");
});

test("[REC-004] chybné pole formuláře plánu nese aria-invalid", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Četnost").selectOption({ label: "Každých N měsíců" });
  const every = page.getByLabel("Každých (měsíců)");
  const day = page.getByRole("spinbutton", { name: "Konkrétní den" });
  await every.fill("");
  await day.fill("");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(every).toHaveAttribute("aria-invalid", "true");
  await expect(day).toHaveAttribute("aria-invalid", "true");
});

test("[REC-004] změna četnosti obnoví náhled 12 termínů", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");

  const rows = page.getByTestId("preview-row");
  await expect(rows).toHaveCount(12);
  const monthly = await rows.nth(1).innerText();

  await page.getByLabel("Četnost").selectOption({ label: "Čtvrtletně" });
  await expect.poll(async () => rows.nth(1).innerText()).not.toBe(monthly);
  await expect(rows).toHaveCount(12);

  await page.getByLabel("Četnost").selectOption({ label: "Každých N měsíců" });
  await expect(page.getByLabel("Každých (měsíců)")).toBeVisible();
  await page.getByLabel("Četnost").selectOption({ label: "Měsíčně" });
  await expect(page.getByLabel("Každých (měsíců)")).toHaveCount(0);
  await page.getByLabel("Den vystavení").selectOption({ label: "Poslední den období" });
  await expect(page.getByLabel("Konkrétní den")).toHaveCount(0);

  await page.getByLabel("Začátek", { exact: true }).fill("");
  await expect(page.getByTestId("schedule-preview")).toContainText("Zadejte začátek plánu");
  await expect(rows).toHaveCount(0);
});

test("[REC-005] [REC-031] pozastavení, obnovení a kontrola zmeškaného termínu", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  const plan = await createPlan(page, baseURL, "Správa webu");
  const planId = plan.split("/").at(-1)!;

  await page.getByRole("button", { name: "Pozastavit" }).click();
  await expect(page.getByTestId("plan-status")).toHaveText("Pozastavený");
  await page.getByRole("button", { name: "Obnovit" }).click();
  await expect(page.getByTestId("plan-status")).toHaveText("Aktivní");

  const sqlite = new Database(join(dataDir, "fakturan.db"));
  const owner = sqlite.prepare("SELECT id FROM user").pluck().get() as string;
  const insert = sqlite.prepare(
    `INSERT INTO recurring_run (id, user_id, recurring_id, period_key, planned_date, period_from, period_to, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'missed', 'Termín je starší než 3 dny', ?)`,
  );
  insert.run(
    "run-a",
    owner,
    planId,
    "2026-01-01",
    "2026-01-15",
    "2026-01-01",
    "2026-01-31",
    Date.now(),
  );
  insert.run(
    "run-b",
    owner,
    planId,
    "2026-02-01",
    "2026-02-15",
    "2026-02-01",
    "2026-02-28",
    Date.now(),
  );
  sqlite.close();

  await page.reload();
  const review = page.getByTestId("review");
  await expect(review).toContainText("Ke kontrole");
  await expect(review.getByRole("listitem")).toHaveCount(2);

  await review.getByRole("button", { name: "Přeskočit: 15. 2. 2026" }).click();
  await expect(review).toContainText("Termín je přeskočený.");

  await review.getByRole("button", { name: "Vytvořit koncept: 15. 1. 2026" }).click();
  await expect(review).toContainText("Koncept je vytvořený.");
  const navigation = page.waitForRequest((request) => request.resourceType() === "document");
  await review.getByRole("link", { name: "Otevřít koncept" }).click();
  await navigation;
  await page.waitForURL(/\/faktury\/[^/]+\/upravit$/);

  await page.goto(plan);
  await expect(page.getByTestId("review")).toHaveCount(0);
  const runs = page.getByTestId("run-row");
  await expect(runs.filter({ hasText: "15. 1. 2026" })).toContainText("Koncept");
  await expect(runs.filter({ hasText: "15. 2. 2026" })).toContainText("Přeskočeno");
});

test("[REC-011] výběr vystavit a odeslat vyžaduje potvrzení", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL, CUSTOMER, "alfa@example.cz");
  await page.goto(`${baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");

  const send = page.getByLabel("Vystavit a odeslat", { exact: true });
  await expect(send).toBeDisabled();
  await expect(page.getByRole("link", { name: "Zapněte ho v Automatizaci" })).toHaveAttribute(
    "href",
    "/nastaveni/automatizace",
  );

  await enableRecurringSend(page, baseURL);
  await page.goto(`${baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill("Odesílaný plán");
  await page.getByRole("combobox", { name: "Zákazník" }).fill("Alf");
  await page.getByRole("option", { name: CUSTOMER }).click();
  await fillLine(page, 0, "Správa webu", "1000");
  await page.getByLabel("Vystavit a odeslat", { exact: true }).check();
  await page.getByRole("button", { name: "Uložit plán" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`zákazníkovi ${CUSTOMER}`);
  await expect(dialog).toContainText("alfa@example.cz");
  await expect(dialog).toContainText("po 09:00");
  await expect(page).toHaveURL(/\/pravidelne\/nova$/);
  await dialog.getByRole("button", { name: "Potvrdit a uložit" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await expect(page.getByRole("radio", { name: "Vystavit a odeslat" })).toBeChecked();

  await page.getByRole("combobox", { name: "Zákazník" }).fill("");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "musí mít zákazníka" })).toBeVisible();
});

test("[REC-012] počet dnů upozornění předem se uloží", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill("S upozorněním");
  await fillLine(page, 0, "Správa webu", "1000");
  await page.getByLabel("Upozornit předem (dnů)").fill("3");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel("Upozornit předem (dnů)")).toHaveValue("3");

  await page.getByLabel("Upozornit předem (dnů)").fill("40");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "od 1 do 30" })).toBeVisible();
});

test("[REC-022] proměnná jde vložit klikem i klávesnicí", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("variable-picker")).toContainText(
    "ze začátku fakturovaného období",
  );

  const before = page.getByLabel("Text před položkami");
  await before.fill("Za  práce");
  await before.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(3, 3));
  await page.getByRole("button", { name: "Vložit proměnnou {{rok}}" }).click();
  await expect(before).toHaveValue("Za {{rok}} práce");

  const picker = page.getByRole("button", { name: "Vložit proměnnou {{mesic_nazev}}" });
  await picker.focus();
  await page.keyboard.press("Enter");
  await expect(before).toHaveValue("Za {{rok}}{{mesic_nazev}} práce");

  const line = page.getByRole("combobox", { name: "Název položky" }).first();
  await line.fill("Správa za ");
  await page.getByRole("button", { name: "Vložit proměnnou {{mesic}}", exact: true }).click();
  await expect(line).toHaveValue("Správa za {{mesic}}");

  await page.getByLabel("Poznámka").fill("{{cena}}");
  await page.getByLabel("Název plánu").fill("Neznámá proměnná");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "{{cena}}" })).toBeVisible();
});

test("změna začátku a počtu u plánu vysvětlí dopad na další termíny", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await createPlan(page, freshApp.baseURL, "Měnící se plán");
  await expect(page.getByTestId("change-impact")).toHaveCount(0);

  await page.getByLabel("Nejvýš termínů").fill("5");
  await expect(page.getByTestId("change-impact")).toContainText(
    "Změnili jste nejvyšší počet termínů.",
  );
  await expect(page.getByTestId("change-impact")).toContainText("Další termín po uložení:");
  await page.getByLabel("Začátek").fill("2099-01-01");
  await expect(page.getByTestId("change-impact")).toContainText("Změnili jste začátek.");
  await expect(page.getByText("Počítají se skutečné běhy plánu")).toBeVisible();
});

test("čtvrtletní pravidelná faktura od plánu po vystavený doklad s předchozím čtvrtletím", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await setSendTime(page, baseURL, "23:59");
  const plan = await planFromTemplate(page, baseURL, "Čtvrtletní správa");

  await page.getByLabel("Název plánu").fill("Čtvrtletní správa");
  await page.getByLabel("Text před položkami").fill("Služby za {{ctvrtleti}}. čtvrtletí {{rok}}");
  await page.getByLabel("Četnost").selectOption({ label: "Čtvrtletně" });
  await page.getByLabel("Posun fakturovaného období").fill("-1");
  await page.getByLabel("Vystavit", { exact: true }).check();
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByText("Plán je uložený.")).toBeVisible();

  await setSendTime(page, baseURL, "00:00");
  await waitForRun(page, plan);
  await expect(page.getByTestId("run-row")).toContainText("Vystaveno");

  await page.getByTestId("plan-invoice").getByRole("link").click();
  await page.waitForURL(/\/faktury\/[^/?]+$/);
  const { year, month } = prague(-3);
  const quarter = Math.ceil(month / 3);
  expect(await issuedPdf(page)).toContain(`Služby za ${quarter}. čtvrtletí ${year}`);
});

test("[REC-014] detail plánu a faktury se odkazují navzájem", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await setSendTime(page, baseURL, "23:59");
  const plan = await planFromTemplate(page, baseURL, "Odkazovaný plán");
  await page.getByLabel("Vystavit", { exact: true }).check();
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByText("Plán je uložený.")).toBeVisible();

  await page.goto(`${baseURL}/pravidelne`);
  await expect(page.getByTestId("plan-row")).toContainText("Odkazovaný plán");
  await expect(page.getByTestId("plan-row")).toContainText("Vystavit");

  await setSendTime(page, baseURL, "00:00");
  await waitForRun(page, plan);
  const invoiceLink = page.getByTestId("plan-invoice").getByRole("link");
  const number = await invoiceLink.innerText();
  await invoiceLink.click();
  await expect(page.getByRole("heading", { name: `Faktura ${number}` })).toBeVisible();

  await page.getByTestId("invoice-plan").getByRole("link", { name: "Odkazovaný plán" }).click();
  await expect(page).toHaveURL(plan);
});

// The account's own server: instance SMTP would also demand e-mail verification at registration.
const smtpTest = test.extend<{ smtp: TestSmtp }>({
  // oxlint-disable-next-line no-empty-pattern
  smtp: async ({}, use) => {
    const server = await startSmtp();
    await use(server);
    await server.stop();
  },
});

smtpTest.use({ allowPrivateMail: true });

smtpTest("vypnutá automatika nepošle pravidelnou fakturu", async ({ page, freshApp, smtp }) => {
  smtpTest.setTimeout(90_000);
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await addSupplier(page, baseURL);
  await addCustomer(page, baseURL, CUSTOMER, "alfa@example.cz");
  await page.goto(`${baseURL}/nastaveni/posta`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Server", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port").fill(String(smtp.port));
  await page.getByLabel("Adresa odesílatele").fill("jan@firma.cz");
  await page.getByLabel("Uživatel").fill("jan");
  await page.getByLabel("Heslo").fill("heslo-smtp");
  await page.getByRole("button", { name: "Uložit" }).first().click();
  await expect(page.getByRole("status")).toContainText("Nastavení pošty je uložené");

  await setSendTime(page, baseURL, "23:59");
  await enableRecurringSend(page, baseURL);
  const plan = await planFromTemplate(page, baseURL, "Odesílaná");
  await page.getByLabel("Vystavit a odeslat", { exact: true }).check();
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Potvrdit a uložit" }).click();
  await expect(page.getByText("Plán je uložený.")).toBeVisible();

  await page.goto(`${baseURL}/nastaveni/automatizace`);
  await page.waitForLoadState("networkidle");
  await automation(page)
    .getByRole("button", { name: /Vypnout/ })
    .click();
  await expect(automation(page)).toContainText("Vypnuto");
  await setSendTime(page, baseURL, "00:00");

  await waitForRun(page, plan);
  await expect(page.getByTestId("run-row")).toContainText("Náhradní koncept");
  await expect(page.getByTestId("run-row")).toContainText("Automatika byla vypnutá");
  await page.waitForTimeout(2000);
  expect(smtp.messages).toHaveLength(0);
});

const pragueDate = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());

test("plán bez názvu se neuloží, pole je označené a dostane fokus", async ({ page, freshApp }) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByLabel("Název plánu")).toBeFocused();
  await expect(page.getByLabel("Název plánu")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Název plánu").fill("Už s názvem");
  await page.getByLabel("Splatnost ve dnech").fill("");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByLabel("Splatnost ve dnech")).toBeFocused();
  await expect(page.getByRole("alert").filter({ hasText: "Zadejte splatnost" })).toBeVisible();
});

test("[REC-001] [REC-002] četnost a den vystavení se uloží a vrátí v detailu", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill("Roční");
  await fillLine(page, 0, "Správa webu", "1000");
  await page.getByLabel("Četnost").selectOption({ label: "Ročně" });
  await page.getByLabel("Den vystavení").selectOption({ label: "První pracovní den" });
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(page.getByLabel("Četnost")).toHaveValue("yearly");
  await expect(page.getByLabel("Den vystavení")).toHaveValue("first_working_day");

  await page.getByLabel("Četnost").selectOption({ label: "Týdně" });
  await page.getByLabel("Den vystavení").selectOption({ label: "Konkrétní den" });
  await page.getByLabel("Konkrétní den").fill("3");
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await expect(page.getByText("Plán je uložený.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Četnost")).toHaveValue("weekly");
  await expect(page.getByLabel("Konkrétní den")).toHaveValue("3");
});

test("[REC-010] [REC-021] režim a posun období se uloží, cizí měna upozorní na koncept", async ({
  page,
  freshApp,
}) => {
  await register(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill("Režim a období");
  await fillLine(page, 0, "Správa webu", "1000");
  await page.getByLabel("Vystavit", { exact: true }).check();
  await page.getByLabel("Posun fakturovaného období").fill("-1");
  const { year, month } = prague(-1);
  await expect(page.getByTestId("preview-row").first()).toContainText(`1. ${month}. ${year} – `);

  await page.getByLabel("Měna").selectOption("EUR");
  await expect(page.getByTestId("foreign-currency")).toContainText("jen koncept");
  await page.getByLabel("Měna").selectOption("CZK");
  await expect(page.getByTestId("foreign-currency")).toHaveCount(0);

  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(page.getByLabel("Vystavit", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Posun fakturovaného období")).toHaveValue("-1");
});

test("[REC-003] plán skončí podle konce a po prodloužení jde znovu aktivovat", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await setSendTime(page, baseURL, "23:59");
  await page.goto(`${baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill("Krátký plán");
  await fillLine(page, 0, "Správa webu", "1000");
  await page.getByLabel("Konec").fill(pragueDate());
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  const plan = page.url();

  await setSendTime(page, baseURL, "00:00");
  await waitForRun(page, plan);
  await expect(page.getByTestId("plan-status")).toHaveText("Hotový");
  await expect(page.getByTestId("reactivate-offer")).toHaveCount(0);

  await page.getByLabel("Konec").fill("2099-12-31");
  await expect(page.getByTestId("reactivate-offer")).toBeVisible();
  await page.getByRole("button", { name: "Znovu aktivovat" }).click();
  await expect(page.getByTestId("plan-status")).toHaveText("Aktivní");
  await page.reload();
  await expect(page.getByTestId("plan-status")).toHaveText("Aktivní");
  await expect(page.getByTestId("reactivate-offer")).toHaveCount(0);
});

test("[REC-024] plán v angličtině vystaví fakturu s anglickým názvem měsíce", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await ready(page, baseURL);
  await setSendTime(page, baseURL, "23:59");
  await page.goto(`${baseURL}/pravidelne/nova`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Název plánu").fill("English plan");
  await page.getByRole("combobox", { name: "Zákazník" }).fill("Alf");
  await page.getByRole("option", { name: CUSTOMER }).click();
  await fillLine(page, 0, "Hosting", "1000");
  await page.getByLabel("Text před položkami").fill("Invoice for {{mesic_nazev}}");
  await page.getByLabel("Jazyk faktury").selectOption("en");
  await page.getByLabel("Způsob platby").selectOption("cash");
  await page.getByLabel("Vystavit", { exact: true }).check();
  await page.getByRole("button", { name: "Uložit plán" }).click();
  await page.waitForURL(/\/pravidelne\/(?!nova)[\w-]+$/);
  await page.waitForLoadState("networkidle");
  const plan = page.url();

  await setSendTime(page, baseURL, "00:00");
  await waitForRun(page, plan);
  await page.getByTestId("plan-invoice").getByRole("link").click();
  await page.waitForURL(/\/faktury\/[^/?]+$/);
  const monthName = new Date().toLocaleString("en-US", {
    month: "long",
    timeZone: "Europe/Prague",
  });
  expect(await issuedPdf(page)).toContain(`Invoice for ${monthName}`);
});
