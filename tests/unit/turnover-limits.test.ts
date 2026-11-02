import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("[REP-005] zákonné limity a prahy jsou napsané jen v lib/turnover-limits", () => {
  const literal = /\b2[_ ]?000[_ ]?000\b|\b200[_]?000[_]?000\b/;
  const offenders = sources("src").filter(
    (path) => !path.endsWith("turnover-limits.ts") && literal.test(readFileSync(path, "utf8")),
  );

  expect(offenders).toEqual([]);
});
