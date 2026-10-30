import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(join(import.meta.dirname, "../..", path), "utf8");

describe("provozní soubory", () => {
  test("[OPS-001] obraz má jeden svazek /data a standalone výstup", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("VOLUME /data");
    expect(dockerfile).toContain("DATA_DIR=/data");
    expect(dockerfile).toContain("/app/.next/standalone");
    expect(read("next.config.ts")).toContain('output: "standalone"');
  });

  test("[TST-011] CI spouští všechny kontroly a nic nenasazuje", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const step of [
      "format:check",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "playwright install",
      "test:e2e",
      "test:coverage-spec",
      "npm run build",
    ]) {
      expect(ci).toContain(step);
    }
    expect(ci).not.toMatch(/deploy/i);
  });

  test("[SEC-009] CI hlídá závislosti s vysokou závažností", () => {
    expect(read(".github/workflows/ci.yml")).toContain("npm audit --audit-level=high");
  });
});
