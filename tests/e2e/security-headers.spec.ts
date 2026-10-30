import { expect, test } from "./fixtures";

test("[SEC-004] odpověď má bezpečnostní hlavičky", async ({ freshApp }) => {
  for (const path of ["/", "/prihlaseni", "/api/auth/get-session"]) {
    const res = await fetch(`${freshApp.baseURL}${path}`);
    const csp = res.headers.get("content-security-policy") ?? "";

    expect(csp, path).toContain("frame-ancestors 'self'");
    expect(csp, path).toContain("object-src 'none'");
    expect(csp, path).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get("strict-transport-security"), path).toMatch(/max-age=\d+/);
    expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    expect(res.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy"), path).toContain("camera=()");
  }
});

test("[SEC-004] stránka s CSP se vykreslí a hydratuje", async ({ page, freshApp }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) violations.push(m.text());
  });
  await page.goto(`${freshApp.baseURL}/prihlaseni`);
  await page.getByLabel("E-mail").fill("a@example.cz");
  await expect(page.getByLabel("E-mail")).toHaveValue("a@example.cz");
  expect(violations).toEqual([]);
});
