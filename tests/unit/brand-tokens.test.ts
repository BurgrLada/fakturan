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

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return (
    "#" +
    linear
      .map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255))
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")
  );
}

// Resolves `color-mix(in oklab, var(--foreground) P%, var(--background))` against the scope's palette.
function mixedToken(scope: string, name: string, set: Record<string, string>): string {
  const match = block(scope).match(
    new RegExp(`--${name}:\\s*color-mix\\(in oklab,\\s*var\\(--foreground\\)\\s*(\\d+)%`),
  );
  expect(match, `--${name} v ${scope}`).not.toBeNull();
  const share = Number(match![1]) / 100;
  const fg = toOklab(set.foreground);
  const bg = toOklab(set.background);
  return fromOklab(fg.map((v, i) => v * share + bg[i] * (1 - share)) as [number, number, number]);
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

  test.each([
    ["světlý", ":root", light],
    ["tmavý", ".dark", dark],
  ] as const)("muted-foreground na pozadí a na muted %s", (_, scope, set) => {
    const mutedText = mixedToken(scope, "muted-foreground", set);
    const mutedSurface = mixedToken(scope, "muted", set);
    expect(contrast(mutedText, set.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mutedText, mutedSurface)).toBeGreaterThanOrEqual(4.5);
  });
});
