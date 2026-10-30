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
