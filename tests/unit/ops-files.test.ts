import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DESIGNS } from "@/server/pdf/designs";

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
  });

  test("[TST-011] části pdf-designs v CI a README pokryjí každý test právě jednou", () => {
    const filtersIn = (text: string) =>
      Array.from(
        text.matchAll(/vitest run tests\/backend\/pdf-designs\.test\.ts -t "([^"]+)"/g),
        (match) => match[1]!,
      );
    const filters = filtersIn(read(".github/workflows/ci.yml"));
    expect(filters.length).toBeGreaterThan(0);
    expect(filtersIn(read("README.md"))).toEqual(filters);

    // Vitest matches -t against "<describe> <test>"; describe.each names one block per design.
    const names: string[] = [];
    let block = "";
    for (const line of read("tests/backend/pdf-designs.test.ts").split("\n")) {
      const opened = /^describe(\.each\(designIds\))?\("([^"]+)"/.exec(line);
      if (opened) block = opened[2]!;
      const found = /^\s*test(?:\.each\([^)]*\))?\("((?:[^"\\]|\\.)+)"/.exec(line);
      if (!found) continue;
      // A test.each row only fills its own placeholders, which no part filters on.
      const title = found[1]!.replaceAll("%s", "x");
      const blocks = block.includes("%s")
        ? DESIGNS.map((design) => block.replace("%s", design.id))
        : [block];
      for (const name of blocks) names.push(`${name} ${title}`);
    }
    expect(names.length).toBeGreaterThan(9 * DESIGNS.length);
    const uncovered = names.filter(
      (name) => filters.filter((filter) => new RegExp(filter).test(name)).length !== 1,
    );
    expect(uncovered).toEqual([]);
    for (const filter of filters) {
      expect(
        names.some((name) => new RegExp(filter).test(name)),
        filter,
      ).toBe(true);
    }
  });

  test("[SEC-009] CI hlídá závislosti s vysokou závažností", () => {
    expect(read(".github/workflows/ci.yml")).toContain("pnpm audit --audit-level=high");
  });
});
