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

  test("[MCP-034] proxy nepřesměruje endpoint MCP, metadata ani trasy OAuth", () => {
    const source = readFileSync(join(root, "src/proxy.ts"), "utf8");
    const sections = new RegExp(/APP_SECTIONS =\s*(\/.*\/);/.exec(source)![1]!.slice(1, -1));
    const matcher = /matcher: \[([^\]]*)\]/.exec(source)![1]!;
    for (const path of [
      "/api/mcp",
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-authorization-server/api/auth",
      "/api/auth/oauth2/authorize",
      "/pristup-asistenta",
    ]) {
      expect(sections.test(path), path).toBe(false);
      expect(matcher).not.toContain(`"/${path.split("/")[1]}`);
    }
  });
});
