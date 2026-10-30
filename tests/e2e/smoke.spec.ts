import { expect, test } from "./fixtures";

test("[TST-004] [UI-001] domovská stránka ukazuje logo a favicon", async ({ page, freshApp }) => {
  await page.goto(freshApp.baseURL);
  const logo = page.getByRole("img", { name: "Fakturan" }).first();
  await expect(logo).toBeVisible();
  // Anonymous `/` redirects on the client, which can destroy the context of a single evaluate.
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth).catch(() => 0))
    .toBeGreaterThan(0);
  await expect(page.locator('link[rel~="icon"]').first()).toHaveAttribute("href", /.+/);
});
