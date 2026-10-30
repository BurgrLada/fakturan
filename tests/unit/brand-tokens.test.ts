import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `blok ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

function token(scope: string, name: string): string {
  const match = block(scope).match(new RegExp(`--${name}:\\s*([^;]+);`));
  expect(match, `--${name} v ${scope}`).not.toBeNull();
  return match![1].trim().toUpperCase();
}

const light: Record<string, string> = {
  background: "#F7F4EE",
  card: "#F7F4EE",
  popover: "#F7F4EE",
  foreground: "#1E1A1C",
  "card-foreground": "#1E1A1C",
  "popover-foreground": "#1E1A1C",
  primary: "#652335",
  ring: "#652335",
  "primary-foreground": "#F7F4EE",
  accent: "#E7C469",
  "accent-foreground": "#1E1A1C",
  "brand-tile": "#C6EC3E",
  "brand-tile-foreground": "#1E1A1C",
};

const dark: Record<string, string> = {
  background: "#1E1A1C",
  card: "#1E1A1C",
  popover: "#1E1A1C",
  foreground: "#F7F4EE",
  "card-foreground": "#F7F4EE",
  "popover-foreground": "#F7F4EE",
  primary: "#C9708A",
  ring: "#C9708A",
  "primary-foreground": "#1E1A1C",
  accent: "#4D4026",
  "accent-foreground": "#F7F4EE",
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("[UI-001] tokeny značky jsou v globals.css", () => {
  test.each(Object.entries(light))("světlý --%s", (name, value) => {
    expect(token(":root", name)).toBe(value);
  });

  test.each(Object.entries(dark))("tmavý --%s", (name, value) => {
    expect(token(".dark", name)).toBe(value);
  });

  test("dlaždice se dědí z :root i v tmavém režimu", () => {
    expect(block(".dark")).not.toContain("--brand-tile");
  });

  test.each(["secondary", "muted", "border", "input"])("odvozený --%s přes color-mix", (name) => {
    for (const scope of [":root", ".dark"]) {
      expect(token(scope, name)).toContain("COLOR-MIX");
    }
  });
});

describe("[UI-008] kontrast splňuje WCAG AA v obou režimech", () => {
  test.each([
    ["světlý", light],
    ["tmavý", dark],
  ] as const)("primary/foreground %s", (_, set) => {
    expect(contrast(set.primary, set["primary-foreground"])).toBeGreaterThanOrEqual(4.5);
  });

  test.each([
    ["světlý", light],
    ["tmavý", dark],
  ] as const)("foreground/background a accent %s", (_, set) => {
    expect(contrast(set.foreground, set.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(set.accent, set["accent-foreground"])).toBeGreaterThanOrEqual(4.5);
  });
});
