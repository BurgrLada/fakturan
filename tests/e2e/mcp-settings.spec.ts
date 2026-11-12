import { answer, authorizeUrl, REDIRECT_URI, registerClient, registerOwner } from "./mcp-helpers";
import { DEMO, expect, test } from "./fixtures";

const OPEN = "/nastaveni/asistenti";
const MASTER = "Povolit připojení asistentů";

test("[MCP-010][MCP-015] zapnutí a vypnutí přístupu", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await registerOwner(page, baseURL);
  await page.goto(`${baseURL}/nastaveni`);
  // MCP-015: the tab is there for an ordinary user, not only an admin.
  await page.getByRole("link", { name: "Asistenti" }).click();
  await expect(page).toHaveURL(new RegExp(`${OPEN}$`));
  await expect(page.getByRole("heading", { name: "Asistenti", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const master = page.getByRole("checkbox", { name: MASTER });
  await expect(master).not.toBeChecked();
  // The address and the setup hints are shown while access is off too.
  await expect(page.getByText(`${baseURL}/api/mcp`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kopírovat" })).toBeVisible();
  await expect(
    page.getByText(`claude mcp add --transport http fakturan ${baseURL}/api/mcp`),
  ).toBeVisible();
  // MCP-045: a local address cannot be reached by a web assistant.
  await expect(page.getByText(/webové asistenty potřebují veřejnou adresu s HTTPS/)).toBeVisible();

  await master.click();
  await expect(page.getByText("Nastavení uloženo")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: MASTER })).toBeChecked();

  await page.getByRole("checkbox", { name: MASTER }).click();
  await expect(page.getByRole("checkbox", { name: MASTER })).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: MASTER })).not.toBeChecked();
});

test("[MCP-054] [MCP-011] zvolí úroveň Účetní operace a po načtení zůstane zvolená", async ({
  page,
  freshApp,
}) => {
  await registerOwner(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}${OPEN}`);
  await page.waitForLoadState("networkidle");
  const group = page.getByRole("radiogroup", { name: "Úroveň oprávnění asistentů" });
  const names = [
    "Jen čtení",
    "Koncepty",
    "Účetní operace",
    "Vystavování a odesílání",
    "Plný přístup",
  ];
  await expect(group.getByRole("radio")).toHaveCount(5);
  for (const name of names) await expect(group.getByRole("radio", { name })).toBeVisible();
  // Every level says in one sentence what it adds.
  await expect(group.getByText("Vše číst. Nic nezměnit.")).toBeVisible();
  // MCP-011: the default is read only.
  await expect(group.getByRole("radio", { name: "Jen čtení" })).toBeChecked();

  // Several quick changes keep working: the revision moves on with every save.
  await group.getByRole("radio", { name: "Koncepty" }).check();
  await expect(page.getByText("Nastavení uloženo")).toBeVisible();
  await group.getByRole("radio", { name: "Účetní operace" }).check();
  await expect(group.getByRole("radio", { name: "Účetní operace" })).toBeChecked();
  for (const name of names) await expect(group.getByRole("radio", { name })).toBeEnabled();
  await page.reload();
  await expect(
    page
      .getByRole("radiogroup", { name: "Úroveň oprávnění asistentů" })
      .getByRole("radio", { name: "Účetní operace" }),
  ).toBeChecked();
});

test("[MCP-062] přepínač Zaznamenávat volání se uloží", async ({ page, freshApp }) => {
  await registerOwner(page, freshApp.baseURL);
  await page.goto(`${freshApp.baseURL}${OPEN}`);
  await page.waitForLoadState("networkidle");
  const log = page.getByRole("checkbox", { name: "Zaznamenávat volání asistentů" });
  await expect(log).toBeChecked();
  await log.click();
  await expect(page.getByText("Nastavení uloženo")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Zaznamenávat volání asistentů" }),
  ).not.toBeChecked();
});

test("[MCP-013] odpojení asistenta zmizí ze seznamu", async ({ page, freshApp }) => {
  const { baseURL } = freshApp;
  await page.route(`${REDIRECT_URI}**`, (route) =>
    route.fulfill({ contentType: "text/plain", body: "ok" }),
  );
  await registerOwner(page, baseURL);
  await page.goto(`${baseURL}${OPEN}`);
  await expect(page.getByText("Zatím není připojený žádný asistent.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("checkbox", { name: MASTER }).click();
  await expect(page.getByText("Nastavení uloženo")).toBeVisible();

  const clientId = await registerClient(baseURL, "Claude Code");
  await page.goto(authorizeUrl(baseURL, clientId, "pripojeni"));
  await expect(page).toHaveURL(/\/pristup-asistenta\?/);
  await answer(page, "Povolit");

  await page.goto(`${baseURL}${OPEN}`);
  await page.waitForLoadState("networkidle");
  const row = page.getByRole("listitem").filter({ hasText: "Claude Code" });
  await expect(row).toContainText("aplikace na tomto počítači");
  await expect(row).toContainText("Připojen");
  await expect(row).toContainText("Zatím nepoužito");

  // Cancelling the confirmation keeps the assistant.
  await row.getByRole("button", { name: "Odpojit" }).click();
  await page.getByRole("button", { name: "Zrušit" }).click();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Odpojit" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Odpojit" }).click();
  await expect(page.getByText("Zatím není připojený žádný asistent.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Seznam propojených asistentů" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Zatím není připojený žádný asistent.")).toBeVisible();
});

test.describe("demo", () => {
  test.use({ demoMode: true });

  test("[MCP-009] v demo režimu záložka chybí", async ({ page, freshApp }) => {
    const { baseURL } = freshApp;
    // The first scheduler tick seeds the account; until then the login is refused.
    await expect(async () => {
      await page.goto(`${baseURL}/prihlaseni`);
      await page.getByLabel("E-mail").fill(DEMO.email);
      await page.getByLabel("Heslo").fill(DEMO.password);
      await page.getByRole("button", { name: "Přihlásit" }).click();
      await expect(page.getByRole("heading", { name: "Přehled", level: 1 })).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 45_000 });
    await page.goto(`${baseURL}/nastaveni`);
    await expect(page.getByRole("navigation", { name: "Nastavení" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Asistenti" })).toHaveCount(0);
    // The page streams its shell first, so notFound() shows as the 404 page, not as a status.
    await page.goto(`${baseURL}${OPEN}`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Asistenti" })).toHaveCount(0);
  });
});
