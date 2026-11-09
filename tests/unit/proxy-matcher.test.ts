import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const appDir = join(root, "src/app/(app)");

const hasPage = (dir: string): boolean =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? hasPage(join(dir, entry.name)) : entry.name === "page.tsx",
  );

describe("proxy", () => {
  test("[UI-009] přesměrování nepřihlášených pokrývá každou sekci aplikace", () => {
    const sections = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && hasPage(join(appDir, entry.name)))
      .map((entry) => entry.name)
      .sort();
    const source = readFileSync(join(root, "src/proxy.ts"), "utf8");
    const listed = (pattern: RegExp) => pattern.exec(source)?.[1]?.split("|").sort();

    expect(sections.length).toBeGreaterThan(0);
    expect(listed(/APP_SECTIONS =\s*\S*?\(\?:\$\|\(\?:([a-z|]+)\)/)).toEqual(sections);
    expect(listed(/"\/\(([a-z|]+)\)\/:path\*"/)).toEqual(sections);
  });
});
