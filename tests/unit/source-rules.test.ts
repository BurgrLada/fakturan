import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function sourceFiles(dir: string): string[] {
  if (statSync(dir).isFile()) return [dir];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function offenders(dirs: string[], pattern: RegExp, allowed: string[] = []): string[] {
  return dirs
    .flatMap(sourceFiles)
    .filter((file) => !allowed.includes(file))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          pattern.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
}

const NEXT_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']next(?:\/[^"']*)?["']/;

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITY =
  "bg|text|border|border-[trblxy]|ring|ring-offset|fill|stroke|from|via|to|outline|divide|shadow|accent|caret|decoration|placeholder";
const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:)*(?:${UTILITY})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?:\\/\\d+)?(?![\\w-])`,
);
// A quoted string with a Czech letter: user-facing text belongs in src/lib/texts.ts (UI-006).
const CZECH_LITERAL = /["'`][^"'`\n]*[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^"'`\n]*["'`]/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;
// Invoice designs carry their own tokens (UI-004), so the picker previews them as they print.
const DESIGN_TOKENS = [join("src", "components", "settings", "design-picker.tsx")];

describe("strukturní pravidla", () => {
  test("[ARC-001] služby a jádro přehledů neimportují next", () => {
    expect(NEXT_IMPORT.test('import { cookies } from "next/headers";')).toBe(true);
    expect(NEXT_IMPORT.test('const m = await import("next/cache");')).toBe(true);
    expect(NEXT_IMPORT.test('import "next";')).toBe(true);
    expect(NEXT_IMPORT.test('import { z } from "zod";')).toBe(false);
    expect(NEXT_IMPORT.test('import { x } from "./next-step";')).toBe(false);

    const dirs = [join("src", "server", "services"), join("src", "server", "reports")];
    expect(dirs.flatMap(sourceFiles).length).toBeGreaterThan(10);
    expect(offenders(dirs, NEXT_IMPORT)).toEqual([]);
  });

  test("[UI-003] komponenty nemají natvrdo barvy", () => {
    for (const sample of [
      'className="bg-red-500"',
      'className="dark:hover:text-slate-900/50"',
      'className="border-white"',
      'style={{ color: "#fff" }}',
      'fill="rgb(0 0 0)"',
      'stroke: "oklch(0.5 0.1 200)"',
    ]) {
      expect(PALETTE_CLASS.test(sample) || COLOR_LITERAL.test(sample), sample).toBe(true);
    }
    for (const sample of [
      'className="bg-primary text-destructive border-input"',
      'className="text-muted-foreground ring-ring"',
      'fill="var(--chart-1)"',
      'className="text-sm"',
    ]) {
      expect(PALETTE_CLASS.test(sample) || COLOR_LITERAL.test(sample), sample).toBe(false);
    }

    const dirs = [join("src", "components"), join("src", "app")];
    expect(offenders(dirs, PALETTE_CLASS)).toEqual([]);
    expect(offenders(dirs, COLOR_LITERAL, DESIGN_TOKENS)).toEqual([]);
    expect(offenders(DESIGN_TOKENS, COLOR_LITERAL).length).toBeGreaterThan(0);
  });

  test("[UI-006] worker, import-parse a pdf-embedded nemají české řetězce mimo texts.ts", () => {
    expect(CZECH_LITERAL.test('throw new Error("Úloha přišla o zámek");')).toBe(true);
    expect(CZECH_LITERAL.test("const x = `Neznámý ${kind}`;")).toBe(true);
    expect(CZECH_LITERAL.test("throw new Error(TEXTS.jobs.lostLease);")).toBe(false);
    expect(CZECH_LITERAL.test('const name = "plain ascii";')).toBe(false);

    const files = [
      join("src", "server", "jobs", "worker.ts"),
      join("src", "server", "services", "import-parse.ts"),
      join("src", "lib", "safe-input", "pdf-embedded.ts"),
    ];
    expect(offenders(files, CZECH_LITERAL)).toEqual([]);
  });
});
