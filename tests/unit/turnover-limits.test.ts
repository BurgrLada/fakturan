import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { limitMailThreshold } from "@/lib/owner-reports";
import { LIMIT_HIGH_PERCENT, LIMIT_WARN_PERCENT } from "@/lib/turnover-limits";

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

test("[REM-012] e-mail o limitu má prahy 80 a 95 %, překročení dává 95", () => {
  expect(limitMailThreshold("ok")).toBeNull();
  expect(limitMailThreshold("warn")).toBe(LIMIT_WARN_PERCENT);
  expect(limitMailThreshold("high")).toBe(LIMIT_HIGH_PERCENT);
  expect(limitMailThreshold("over")).toBe(95);
  expect([LIMIT_WARN_PERCENT, LIMIT_HIGH_PERCENT]).toEqual([80, 95]);
});
