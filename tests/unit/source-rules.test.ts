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

const USE_CACHE = /^\s*["']use cache(?::[^"']*)?["'];?\s*$/;

// Every function whose body starts with the directive: its parameters and the body up to the first
// line that closes it at the indentation of the declaration.
function cachedFunctions(file: string, text = readFileSync(file, "utf8")) {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    if (!USE_CACHE.test(line)) return [];
    let start = index;
    while (start > 0 && !/\bfunction\b|=>\s*\{\s*$/.test(lines[start]!)) start -= 1;
    const indent = /^\s*/.exec(lines[start]!)![0];
    let end = index;
    while (end < lines.length - 1 && lines[end] !== `${indent}}`) end += 1;
    const signature = lines.slice(start, index).join("\n");
    const body = lines.slice(index, end + 1).join("\n");
    return [{ where: `${file}:${index + 1}`, signature, body }];
  });
}

describe("strukturní pravidla", () => {
  test("[REM-012] prahy a limit jsou jen v turnover-limits.ts", () => {
    // Bare 80 or 95 outside an unrelated length cap (`.max(80`, a text limit, its message).
    const THRESHOLD = /200_?000_?000|(?<![\w.-])(?:80|95)(?![\w.])/;
    const UNRELATED = /\.max\(80\b|": 80,|80 znaků/;
    expect(THRESHOLD.test("warn: 80,")).toBe(true);
    expect(THRESHOLD.test("`Nad 95 %`")).toBe(true);
    expect(THRESHOLD.test("const LIMIT = 200_000_000;")).toBe(true);
    expect(THRESHOLD.test("max: 800, id: 9500, v1.80")).toBe(false);

    const dirs = [join("src", "server"), join("src", "lib")];
    const allowed = [join("src", "lib", "turnover-limits.ts")];
    expect(offenders(dirs, THRESHOLD, allowed).filter((line) => !UNRELATED.test(line))).toEqual([]);
  });

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

  test('[ARC-005] každá funkce s "use cache" má cacheTag(accountTag(userId)) a razítko v parametrech', () => {
    const sample = (params: string, tag: string) =>
      [
        `export async function cachedX(${params}) {`,
        '  "use cache";',
        `  cacheTag(${tag});`,
        "  return 1;",
        "}",
      ].join("\n");
    const ok = (text: string) => {
      const [found] = cachedFunctions("sample.ts", text);
      return (
        /\buserId: string\b/.test(found!.signature) &&
        /\bstamp: string\b/.test(found!.signature) &&
        /cacheTag\(accountTag\(userId\)\)/.test(found!.body)
      );
    };
    expect(ok(sample("userId: string, stamp: string", "accountTag(userId)"))).toBe(true);
    expect(ok(sample("userId: string", "accountTag(userId)"))).toBe(false);
    expect(ok(sample("ownerId: string, stamp: string", "accountTag(ownerId)"))).toBe(false);
    expect(ok(sample("userId: string, stamp: string", '"reports"'))).toBe(false);

    const files = sourceFiles("src");
    const directives = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => USE_CACHE.test(line)),
    );
    const cached = files.flatMap((file) => cachedFunctions(file));
    expect(cached.length).toBeGreaterThan(0);
    expect(cached).toHaveLength(directives.length);
    for (const { where, signature, body } of cached) {
      expect(signature, where).toMatch(/\buserId: string\b/);
      expect(signature, where).toMatch(/\bstamp: string\b/);
      expect(body, where).toMatch(/cacheTag\(accountTag\(userId\)\)/);
    }
  });
});
