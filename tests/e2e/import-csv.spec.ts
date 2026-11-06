import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { register } from "./invoice-helpers";

test.setTimeout(120_000);

test("[IMP-001] průvodce od CSV po zákazníka v seznamu", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page.goto(`${baseURL}/nastaveni/import`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Tabulku CSV nebo Excel").check();
  await page.getByLabel("Tabulka k importu").setInputFiles({
    name: "zakaznici.csv",
    mimeType: "text/csv",
    buffer: readFileSync(join("tests", "fixtures", "import", "zakaznici.csv")),
  });
  await page.getByRole("button", { name: "Zpracovat" }).click();

  await expect(page.getByRole("heading", { name: "Mapování sloupců" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Co importujete")).toHaveValue("customers");
  await expect(page.getByLabel("Název (povinné)")).toHaveValue("Název");
  await page.getByLabel("PSČ").selectOption("");
  const sample = page.getByRole("table", { name: "Náhled mapování" });
  await expect(sample).toContainText("Alfa Zkušební s. r. o.");
  await expect(sample).toContainText("neni-email");

  await page.getByLabel("Název předlohy").fill("Moje zákazníci");
  await page.getByRole("button", { name: "Uložit jako předlohu" }).click();
  await expect(page.getByText("Předloha je uložená.")).toBeVisible();
  await expect(page.getByLabel("Předloha")).toHaveValue(/.+/);

  await page.getByRole("button", { name: "Pokračovat na náhled" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Připraveno ke kontrole", {
    timeout: 30_000,
  });
  const preview = page.getByRole("table", { name: "Náhled importu" });
  await expect(preview).toContainText("Beta Pokusná");
  await expect(preview).toContainText("Řádek 5, sloupec „E-mail“");
  await expect(page.getByRole("button", { name: "Uložit záznamy" })).toBeDisabled();
  await page.getByTestId("import-row-r4").getByRole("button", { name: "Přeskočit" }).click();
  await expect(page.getByRole("button", { name: "Uložit záznamy" })).toBeEnabled();
  await page.getByRole("button", { name: "Uložit záznamy" }).click();
  await expect(page.getByTestId("import-status")).toHaveText("Hotovo", { timeout: 30_000 });
  await expect(page.getByText("Uloženo 4 záznamů.")).toBeVisible();

  await page.goto(`${baseURL}/zakaznici`);
  await expect(page.getByText("Alfa Zkušební s. r. o.")).toBeVisible();
  await expect(page.getByText('=HYPERLINK("http://example.test","klik")')).toBeVisible();
});
