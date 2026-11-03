import { describe, expect, test } from "vitest";
import { formatWidgetValue, percentChange } from "@/components/dashboard/widget-number";

describe("číslo widgetu", () => {
  test("procento rozdílu je celé, půl od nuly, a u nulového základu chybí", () => {
    expect(percentChange(150_000, 100_000)).toBe(50);
    expect(percentChange(100_500, 100_000)).toBe(1);
    expect(percentChange(99_500, 100_000)).toBe(-1);
    expect(percentChange(100_000, 0)).toBeNull();
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(-50, -100)).toBe(50);
  });

  test("procento u neceločíselných dnů do úhrady nespadne", () => {
    expect(percentChange(12.5, 10)).toBe(25);
    expect(percentChange(10, 12.5)).toBe(-20);
    expect(percentChange(10 / 3, 10 / 3)).toBe(0);
    expect(percentChange(0.04, 0.01)).toBeNull();
    expect(formatWidgetValue(2.5, { kind: "days" })).toBe("2,5 dne");
  });
});
