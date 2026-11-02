import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { contrastRatio, isHexColor, MIN_TEXT_CONTRAST, readableOn } from "@/lib/contrast";

describe("kontrast barev", () => {
  test("[PDF-003] kontrast černé na bílé je 21, nízký kontrast varuje", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(contrastRatio("#999999", "#ffffff")).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio("#595959", "#ffffff")).toBeGreaterThan(MIN_TEXT_CONTRAST);
  });

  test("[PDF-003] text na akcentu je čitelný pro každou barvu plochy", () => {
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#000000");
    for (let value = 0; value < 0xffffff; value += 0x020407) {
      const color = `#${value.toString(16).padStart(6, "0")}`;
      expect(contrastRatio(color, readableOn(color)), color).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    }
  });

  test("[PDF-003] hex barva má tvar #rrggbb", () => {
    expect(isHexColor("#a1B2c3")).toBe(true);
    for (const value of ["", "#abc", "a1b2c3", "#a1b2c34", "#gggggg"]) {
      expect(isHexColor(value)).toBe(false);
    }
  });
});

describe("barvy grafů", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const block = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    return css.slice(start, css.indexOf("\n}", start));
  };
  const channel = (value: number) =>
    value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  const byte = (value: number) => Math.round(Math.min(1, Math.max(0, channel(value))) * 255);
  const hex = (r: number, g: number, b: number) =>
    `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;

  function oklchToHex(value: string): string {
    const match = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(value);
    if (!match) throw new Error(value);
    const [l, c, h] = [Number(match[1]), Number(match[2]), (Number(match[3]) * Math.PI) / 180];
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return hex(
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    );
  }

  test.each([
    ["Light", ":root", "#f7f4ee"],
    ["Dark", ".dark", "#1e1a1c"],
  ])(
    "[UI-005] tokeny chart-1 až chart-5 mají proti pozadí aspoň 3:1 (%s)",
    (_name, selector, bg) => {
      const section = block(selector);
      expect(section).toContain(`--background: ${bg};`);
      for (const n of [1, 2, 3, 4, 5]) {
        const match = new RegExp(`--chart-${n}: (oklch\\([^)]+\\));`).exec(section);
        expect(match, `--chart-${n}`).not.toBeNull();
        expect(contrastRatio(oklchToHex(match![1]!), bg), `--chart-${n}`).toBeGreaterThanOrEqual(3);
      }
    },
  );
});
