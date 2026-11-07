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
      "pnpm run lint",
      "pnpm run typecheck",
      "vitest run --project unit",
      "playwright install",
      "test:e2e",
      "test:coverage-spec",
      "pnpm run build",
    ]) {
      expect(ci).toContain(step);
    }
    expect(ci).not.toMatch(/deploy/i);
  });

  test("[TST-011] CI pouští backend po šesti shardech bez pdf-designs a pdf-designs po čtyřech částech", () => {
    const ci = read(".github/workflows/ci.yml");
    for (let n = 1; n <= 6; n += 1) {
      expect(ci).toContain(
        `vitest run --project backend --shard=${n}/6 --exclude tests/backend/pdf-designs.test.ts`,
      );
    }
    expect(ci).not.toMatch(/--shard=\d+\/4/);
    for (const part of [
      "registr designů",
      "vizuální regrese",
      "barvy vystaveného dokladu",
      "náhled designu",
    ]) {
      expect(ci).toContain(`vitest run tests/backend/pdf-designs.test.ts -t "${part}"`);
    }
  });

  test("[SEC-009] CI hlídá závislosti s vysokou závažností", () => {
    expect(read(".github/workflows/ci.yml")).toContain("pnpm audit --audit-level=high");
  });
});
