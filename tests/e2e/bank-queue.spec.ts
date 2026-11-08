import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { startImap } from "../helpers/imap";
import { expect, test } from "./fixtures";
import {
  addAccount,
  cashInvoice,
  issue,
  openForm,
  ready,
  register,
  settled,
} from "./invoice-helpers";

test.setTimeout(90_000);

type NoticeSeed = {
  status?: "pending" | "unrecognized" | "ignored";
  variant?: string | null;
  reason?: string | null;
  amountMinor?: number | null;
  text?: string;
  symbol?: string;
  currency?: string;
};

function invoiceSymbol(dataDir: string): string {
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  try {
    return sqlite.prepare("SELECT variable_symbol FROM invoice").pluck().get() as string;
  } finally {
    sqlite.close();
  }
}

function seedNotice(dataDir: string, seed: NoticeSeed = {}) {
  const status = seed.status ?? "pending";
  const recognized = status !== "unrecognized";
  const sqlite = new Database(join(dataDir, "fakturan.db"));
  try {
    const owner = sqlite.prepare("SELECT id FROM user").pluck().get() as string;
    const id = randomUUID();
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO bank_notification (id, user_id, dedupe_key, bank, variant, status, reason, auth_result,
          amount_minor, currency, paid_on, paid_time, variable_symbol, counterparty_name, message,
          instruction_id, text_masked, received_at, created_at, updated_at)
         VALUES (@id, @owner, @key, 'fio', @variant, @status, @reason, 'none', @amount, @currency,
          @paidOn, @paidTime, @vs, @name, @message, @instruction, @text, @now, @now, @now)`,
      )
      .run({
        id,
        owner,
        key: `test:${id}`,
        variant: recognized ? (seed.variant ?? "cs") : null,
        status,
        reason: recognized ? (seed.reason ?? "unknown_vs") : null,
        amount: recognized ? (seed.amountMinor ?? 100_000) : null,
        currency: recognized ? (seed.currency ?? "CZK") : null,
        paidOn: recognized ? "2026-10-30" : null,
        paidTime: recognized ? "14:05" : null,
        vs: recognized ? (seed.symbol ?? "777") : null,
        name: recognized ? "Ukázková firma" : null,
        message: recognized ? "Za konzultaci" : null,
        instruction: recognized ? id : null,
        text: seed.text ?? null,
        now,
      });
    return id;
  } finally {
    sqlite.close();
  }
}

const dialog = (page: Page) => page.getByRole("alertdialog");

test("[UI-011] [BNK-012] nespárované a nerozpoznané jsou v centru i na zvonku a po vyřízení zmizí", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  seedNotice(dataDir);
  const longText = `Fio banka - nová zpráva\nÚčet ******9999/2010 ${"x".repeat(300)}`;
  seedNotice(dataDir, { status: "unrecognized", text: longText });

  await page.goto(`${baseURL}/upozorneni`);
  await expect(page.getByText("Platby z avíz čekající na spárování: 1")).toBeVisible();
  await expect(page.getByText("Nerozpoznaná avíza z banky: 1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Upozornění, nepřečtených: 2" })).toBeVisible();

  await page.goto(`${baseURL}/platby`);
  const rows = page.getByTestId("notice-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("Nerozpoznaný formát").first()).toBeVisible();
  const text = page.getByTestId("notice-text");
  await expect(text).toContainText("Fio banka - nová zpráva");
  await expect(text).toContainText("******9999/2010");
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByText("Variabilní symbol neodpovídá žádnému dokladu.")).toBeVisible();
  for (let left = 2; left > 0; left--) {
    await rows.first().getByRole("button", { name: "Zahodit" }).click();
    await dialog(page).getByRole("button", { name: "Zahodit avízo" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole("heading", { name: "Historie" })).toBeVisible();
    await expect
      .poll(() => page.getByTestId("notice-row").filter({ hasText: "Zahozeno" }).count())
      .toBe(3 - left);
  }

  await page.goto(`${baseURL}/upozorneni`);
  await expect(page.getByText("Platby z avíz čekající na spárování")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Upozornění, nepřečtených: 0" })).toBeVisible();
});

test("[BNK-005] prozatímní anglické avízo má štítek v seznamu i dialogu", async ({
  page,
  freshApp,
}) => {
  const { baseURL, dataDir } = freshApp;
  await register(page, baseURL);
  seedNotice(dataDir, { variant: "en", reason: "provisional" });
  seedNotice(dataDir, { variant: "cs" });

  await page.goto(`${baseURL}/platby`);
  const rows = page.getByTestId("notice-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("provisional-badge")).toHaveCount(1);
  const provisional = rows.filter({ has: page.getByTestId("provisional-badge") });
  await expect(provisional).toContainText("Prozatímní formát");

  await provisional.getByRole("button", { name: "Přiřadit" }).click();
  await expect(dialog(page).getByTestId("provisional-badge")).toBeVisible();
  await expect(dialog(page).getByTestId("provisional-notice")).toContainText("zatím prozatímní");
});

test("[BNK-015] [BNK-003] stránka ukáže stav napojení a Zkontrolovat teď", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/platby`);
  await expect(page.getByTestId("bank-status")).toContainText("Schránka s avízy není nastavená");
  await expect(page.getByRole("link", { name: "Nastavit schránku" })).toHaveAttribute(
    "href",
    "/nastaveni/aviza",
  );
  await expect(page.getByRole("button", { name: "Zkontrolovat teď" })).toHaveCount(0);
});

test.describe("vlastní schránka", () => {
  test.use({ allowPrivateMail: true });

  test("[BNK-015] [BNK-003] nastavená schránka ukáže stav a tlačítko zařadí kontrolu", async ({
    page,
    freshApp,
  }) => {
    const imap = await startImap();
    try {
      const { baseURL } = freshApp;
      await register(page, baseURL);
      await page.goto(`${baseURL}/nastaveni/aviza`);
      await page.waitForLoadState("networkidle");
      await page.getByLabel("Server IMAP").fill("127.0.0.1");
      await page.getByLabel("Port").fill(String(imap.port));
      await page.getByLabel("Šifrování").selectOption("starttls");
      await page.getByLabel("Uživatel").fill("avizo");
      await page.getByLabel("Heslo").fill("tajne-heslo-imap-4c1d");
      await page.getByRole("button", { name: "Uložit" }).click();
      await expect(page.getByRole("status")).toContainText("Nastavení schránky je uložené");

      await page.goto(`${baseURL}/platby`);
      const status = page.getByTestId("bank-status");
      await expect(status).toContainText("Napojení funguje");
      await expect(status).toContainText("Poslední kontrola");
      await page.getByRole("button", { name: "Zkontrolovat teď" }).click();
      await expect(status).toContainText("Kontrola je zařazená");
      await expect.poll(() => imap.logins.length).toBeGreaterThanOrEqual(1);
      await page.reload();
      await expect(status).not.toContainText("Poslední kontrola: zatím nikdy");
    } finally {
      await imap.close();
    }
  });

  test("[BNK-010] [BNK-014] přiřazení z fronty zapíše platbu a vrácení z panelu ji smaže", async ({
    page,
    freshApp,
  }) => {
    const { baseURL, dataDir } = freshApp;
    await ready(page, baseURL);
    await addAccount(page, baseURL);
    await openForm(page, baseURL);
    await cashInvoice(page);
    await settled(page);
    await issue(page);
    await page.waitForLoadState("networkidle");
    const invoiceUrl = page.url();
    seedNotice(dataDir);

    await page.goto(`${baseURL}/platby`);
    await page.getByRole("button", { name: "Přiřadit" }).click();
    await dialog(page).getByLabel("Doklad", { exact: true }).selectOption({ index: 1 });
    await expect(dialog(page)).toContainText("nic neodešle klientovi");
    await dialog(page).getByRole("button", { name: "Přiřadit platbu" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText("Žádná platba nečeká na vyřízení.")).toBeVisible();
    await expect(page.getByTestId("notice-row")).toContainText("Spárováno");

    await page.goto(invoiceUrl);
    await expect(page.getByTestId("payment-row")).toHaveCount(1);
    await expect(page.getByTestId("payment-row")).toContainText("Z avíza");
    await expect(page.getByTestId("payment-paid")).toContainText("1 000,00");

    await page.getByRole("button", { name: "Vrátit avízo" }).click();
    await expect(dialog(page)).toContainText("vzít ho zpět nejde");
    await dialog(page).getByRole("button", { name: "Vrátit avízo" }).click();
    await expect(page.getByTestId("payment-row")).toHaveCount(0);
    await expect(page.getByTestId("payment-paid")).toContainText("0,00");

    await page.goto(`${baseURL}/platby`);
    await expect(page.getByTestId("notice-row")).toContainText("Spárování bylo vráceno.");
    await expect(page.getByRole("button", { name: "Přiřadit" })).toBeVisible();
  });

  test("[PAY-006] přiřazení avíza v jiné měně předvyplní připsanou částku", async ({
    page,
    freshApp,
  }) => {
    const { baseURL, dataDir } = freshApp;
    await ready(page, baseURL);
    await addAccount(page, baseURL);
    await openForm(page, baseURL);
    await cashInvoice(page);
    await settled(page);
    await issue(page);
    await page.waitForLoadState("networkidle");
    seedNotice(dataDir, { currency: "USD", amountMinor: 10_000 });

    await page.goto(`${baseURL}/platby`);
    await page.getByRole("button", { name: "Přiřadit" }).click();
    await dialog(page).getByLabel("Doklad", { exact: true }).selectOption({ index: 1 });
    await expect(dialog(page).getByLabel(/Připsáno/)).toHaveValue("2231,10");
    await expect(dialog(page).getByText("Předvyplněno kurzy ČNB")).toBeVisible();
  });

  test("[BNK-007] avízo na cizí účet jde přiřadit ručně a dialog na to upozorní", async ({
    page,
    freshApp,
  }) => {
    const { baseURL, dataDir } = freshApp;
    await ready(page, baseURL);
    await addAccount(page, baseURL);
    await openForm(page, baseURL);
    await cashInvoice(page);
    await settled(page);
    await issue(page);
    await page.waitForLoadState("networkidle");
    seedNotice(dataDir, { status: "ignored", reason: "foreign_account" });

    await page.goto(`${baseURL}/platby`);
    await page.getByRole("button", { name: "Přiřadit" }).click();
    await expect(dialog(page).getByTestId("foreign-account-warning")).toBeVisible();
    await dialog(page).getByLabel("Doklad", { exact: true }).selectOption({ index: 1 });
    await dialog(page).getByRole("button", { name: "Přiřadit platbu" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByTestId("notice-row")).toContainText("Spárováno");
  });

  test("[REM-003] avízo ve frontě ukáže varování v panelu upomínek", async ({ page, freshApp }) => {
    const { baseURL, dataDir } = freshApp;
    await ready(page, baseURL);
    await addAccount(page, baseURL);
    await openForm(page, baseURL);
    await cashInvoice(page);
    await settled(page);
    await issue(page);
    await page.waitForLoadState("networkidle");
    const invoiceUrl = page.url();
    await expect(page.getByTestId("reminder-queued-notice")).toHaveCount(0);

    seedNotice(dataDir, { symbol: invoiceSymbol(dataDir) });

    await page.goto(invoiceUrl);
    await expect(page.getByTestId("reminder-queued-notice")).toBeVisible();
  });
});
