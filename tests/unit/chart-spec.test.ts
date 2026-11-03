import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CHART_TOKENS,
  type ChartSpec,
  chartTableModel,
  formatChartValue,
  isChartToken,
} from "@/components/charts/chart-spec";

const spec: ChartSpec = {
  kind: "stacked_bar",
  series: [
    { key: "paid", label: "Uhrazeno", token: "chart-1" },
    { key: "open", label: "Neuhrazeno", token: "chart-3" },
  ],
  rows: [
    { x: "2026-01", label: "leden 2026", values: { paid: 123456, open: -250000 } },
    { x: "2026-02", label: "únor 2026", values: { paid: 0 } },
  ],
  format: { kind: "money", currency: "CZK" },
  ariaLabel: "Fakturace po měsících",
  ariaDescription: "Částky v korunách",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("obal Chart", () => {
  test("[ARC-006] knihovna grafu je importovaná jen v src/components/charts", () => {
    const allowed = join("src", "components", "charts") + sep;
    const importers = sourceFiles("src")
      .filter((file) => /@tanstack\/charts|recharts/.test(readFileSync(file, "utf8")))
      .filter((file) => !file.startsWith(allowed));
    expect(importers).toEqual([]);
    const inside = sourceFiles(join("src", "components", "charts")).filter((file) =>
      readFileSync(file, "utf8").includes("@tanstack/charts"),
    );
    expect(inside.length).toBeGreaterThan(0);
  });

  test("[ARC-006] ChartSpec jde serializovat a nemá funkce", () => {
    const copy = JSON.parse(JSON.stringify(spec)) as ChartSpec;
    expect(copy).toEqual(spec);
    const walk = (value: unknown): void => {
      expect(typeof value).not.toBe("function");
      if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(spec);
  });

  test("[UI-008] každý graf vyžaduje ariaLabel a tabulka uvádí všechny hodnoty", () => {
    // @ts-expect-error ariaLabel is required
    const missing: ChartSpec = { ...spec, ariaLabel: undefined };
    expect(missing.ariaLabel).toBeUndefined();

    const model = chartTableModel(spec);
    expect(model.corner).toBe("Období");
    expect(chartTableModel({ ...spec, corner: "Zákazník" }).corner).toBe("Zákazník");
    expect(model.head).toEqual(["Uhrazeno", "Neuhrazeno"]);
    expect(model.rows.map((row) => row.label)).toEqual(["leden 2026", "únor 2026"]);
    const text = (value: string) => value.replace(/\s/g, " ");
    expect(model.rows[0]?.cells.map(text)).toEqual(["1 234,56 Kč", "-2 500,00 Kč"]);
    expect(model.rows[1]?.cells.map(text)).toEqual(["0,00 Kč", "0,00 Kč"]);
  });

  test("[UI-005] tokeny chart-1 až chart-5 jsou jediné povolené", () => {
    expect(CHART_TOKENS).toEqual(["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]);
    expect(CHART_TOKENS.every(isChartToken)).toBe(true);
    for (const value of ["chart-0", "chart-6", "#ff0000", "var(--chart-1)", "", null, 1]) {
      expect(isChartToken(value)).toBe(false);
    }
  });

  test("popisek osy 1 234,56 Kč vzniká z celého čísla", () => {
    const label = formatChartValue({ kind: "money", currency: "CZK" }, 123456);
    expect(label.replace(/\s/g, " ")).toBe("1 234,56 Kč");
    expect(formatChartValue({ kind: "number" }, 1234.4).replace(/\s/g, " ")).toBe("1 234");
    expect(formatChartValue({ kind: "money", currency: "EUR" }, 50).replace(/\s/g, " ")).toBe(
      "0,50 €",
    );
  });
});
