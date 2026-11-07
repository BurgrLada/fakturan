import { TEXTS } from "@/lib/texts";
import { expect, test } from "./fixtures";
import { register } from "./invoice-helpers";

const H = TEXTS.help;

test("[UI-012] Nápověda se otevře z navigace, kotva skočí na kapitolu a FAQ jde rozbalit klávesnicí", async ({
  page,
  freshApp,
}) => {
  const { baseURL } = freshApp;
  await register(page, baseURL);
  await page
    .getByRole("navigation", { name: "Hlavní navigace" })
    .getByRole("link", { name: "Nápověda" })
    .click();
  await expect(page).toHaveURL(`${baseURL}/napoveda`);
  await expect(page.getByRole("heading", { name: H.title, level: 1 })).toBeVisible();

  const credit = H.chapters.find((chapter) => chapter.id === "opravne-faktury");
  if (!credit) throw new Error("missing chapter");
  await page
    .getByRole("navigation", { name: H.contents })
    .getByRole("link", { name: credit.title })
    .click();
  await expect(page).toHaveURL(`${baseURL}/napoveda#opravne-faktury`);
  await expect(page.getByRole("heading", { name: credit.title, level: 2 })).toBeInViewport();
  await expect(page.getByRole("heading", { name: credit.title, level: 2 })).toBeFocused();

  await page.goto(`${baseURL}/faktury`);
  await page.goto(`${baseURL}/napoveda#zalohy`);
  const advances = H.chapters.find((chapter) => chapter.id === "zalohy");
  if (!advances) throw new Error("missing chapter");
  await expect(page.getByRole("heading", { name: advances.title, level: 2 })).toBeInViewport();
  await expect(page.getByRole("heading", { name: advances.title, level: 2 })).toBeFocused();

  await page.goto(`${baseURL}/faktury`);
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Rychlé hledání" });
  await dialog.getByRole("combobox").fill("opravné faktury");
  await dialog
    .getByRole("group", { name: "Stránky" })
    .getByRole("option", { name: new RegExp(credit.title) })
    .click();
  await expect(page).toHaveURL(`${baseURL}/napoveda#opravne-faktury`);
  await expect(page.getByRole("heading", { name: credit.title, level: 2 })).toBeInViewport();
  await expect(page.getByRole("heading", { name: credit.title, level: 2 })).toBeFocused();

  const [first] = H.faq;
  if (!first) throw new Error("missing faq");
  const question = page.locator("summary", { hasText: first.q });
  const answer = page.getByText(first.a, { exact: true });
  await expect(answer).toBeHidden();
  await question.focus();
  await expect(question).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(answer).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(answer).toBeHidden();

  const invoice = H.chapters.find((chapter) => chapter.id === "faktura");
  if (!invoice) throw new Error("missing chapter");
  await page
    .getByRole("list", { name: `${H.links}: ${invoice.title}` })
    .getByRole("link", { name: "Číselné řady" })
    .click();
  await expect(page).toHaveURL(`${baseURL}/nastaveni/rady`);
});
