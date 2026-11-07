import { expect, test } from "./fixtures";

test("[OPS-004] /api/health hlásí běžící plánovač bez citlivých údajů", async ({ freshApp }) => {
  const read = async () => {
    const res = await fetch(`${freshApp.baseURL}/api/health`);
    return { code: res.status, body: await res.json() };
  };
  await expect
    .poll(read, { timeout: 15_000 })
    .toEqual({ code: 200, body: { status: "ok", database: "ok", scheduler: "running" } });
  expect(JSON.stringify((await read()).body)).not.toMatch(/fakturan|secret|key|\/tmp/i);
});

test("[MON-001] bez SENTRY_DSN klient nic neposílá a tunel neexistuje", async ({
  page,
  freshApp,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(freshApp.baseURL);
  await page.waitForLoadState("networkidle");
  expect((await fetch(`${freshApp.baseURL}/api/monitoring`)).status).toBe(404);
  expect(requests.filter((u) => u.includes("envelope"))).toEqual([]);
});

test("[ADM-008] administrace ukáže stav instance bez tajemství", async ({ page, freshApp }) => {
  await page.goto(`${freshApp.baseURL}/registrace`);
  await page.getByLabel("Jméno").fill("Správce");
  await page.getByLabel("E-mail").fill("admin@example.cz");
  await page.getByLabel("Heslo").fill("správné-kůň-baterie-sponka");
  await page.getByRole("button", { name: "Vytvořit účet" }).click();
  await expect(page.getByText("admin@example.cz")).toBeVisible();
  await page.goto(`${freshApp.baseURL}/administrace`);
  await page.getByRole("tab", { name: "Stav instance" }).click();
  await expect(page.getByRole("row", { name: /^Verze \d+\.\d+\.\d+/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Plánovač (běží|spouští se)/ })).toBeVisible();
  // The scheduler backs up on its first tick after 2:30, so a fresh app may already have a backup.
  await expect(
    page.getByRole("row", {
      name: /^Poslední záloha (žádná|\d{1,2}\. \d{1,2}\. \d{4} \d{1,2}:\d{2})/,
    }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /^SMTP nenastaveno/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Monitoring chyb nenastaveno/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Velikost databáze/ })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /^Velikost souborů (zatím nezměřeno|\d[\d,]* (B|KB|MB|GB))/ }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /^Volné místo na svazku \d/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Poslední kurzovní lístek ČNB/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Těžké úlohy ve frontě \d/ })).toBeVisible();
});
