import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseTarget, reportPath, strykerConfig } from "../../scripts/mutation";
import {
  CORE,
  mergeReports,
  pickReports,
  scoreOf,
  summarize,
} from "../../scripts/mutation-summary";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

function mutatedFiles(): string[] {
  const patterns: string[] = read("stryker.config.json").mutate;
  return patterns.flatMap((pattern) => globSync(pattern, { cwd: root })).sort();
}

describe("mutační testy po souborech", () => {
  test("[TST-013] každý soubor v mutate má záznam ve stryker.map.json a mapované testy existují", () => {
    const map: Record<string, string[]> = read("stryker.map.json");
    const files = mutatedFiles();
    expect(Object.keys(map).sort()).toEqual(files);
    for (const file of files) {
      expect(map[file].length, file).toBeGreaterThan(0);
      for (const testFile of map[file]) {
        expect(existsSync(join(root, testFile)), `${file} → ${testFile}`).toBe(true);
        expect(testFile).toMatch(/^tests\/(unit|backend)\/.+\.test\.ts$/);
      }
    }
  });

  test("[TST-013] jádro včetně fronty, lease a ticku je v mutate", () => {
    const files = mutatedFiles();
    for (const file of [
      "src/server/jobs/queue.ts",
      "src/server/scheduler/lease.ts",
      "src/server/scheduler/tick.ts",
      "src/server/services/number-series.ts",
    ]) {
      expect(files).toContain(file);
    }
    for (const file of CORE) expect(files, file).toContain(file);
    expect(CORE).toContain("src/lib/bank-notices/fio.ts");
    expect(CORE).not.toContain("src/server/isdoc/parse.ts");
  });

  test("[TST-013] cíl souboru přijme rozsah řádků a zprávu pojmenuje podle něj", () => {
    expect(parseTarget("src/lib/money.ts")).toEqual({ file: "src/lib/money.ts", range: null });
    expect(parseTarget("src/lib/money.ts:10-20")).toEqual({
      file: "src/lib/money.ts",
      range: [10, 20],
    });
    expect(() => parseTarget("src/lib/money.ts:20-10")).toThrow();
    expect(() => parseTarget("src/lib/money.ts:x")).toThrow();
    expect(reportPath({ file: "src/lib/money.ts", range: null })).toBe(
      "reports/mutation/src/lib/money.ts.json",
    );
    expect(reportPath({ file: "src/lib/money.ts", range: [10, 20] })).toBe(
      "reports/mutation/src/lib/money.ts@10-20.json",
    );
  });

  test("[TST-013] dočasná konfigurace mutuje jeden soubor a testy vybírá konfigurace Vitestu", () => {
    const base = read("stryker.config.json");
    const config = strykerConfig(base, { file: "src/lib/money.ts", range: [10, 20] });
    expect(config.mutate).toEqual(["src/lib/money.ts:10-20"]);
    expect(config).not.toHaveProperty("testFiles");
    expect(config.reporters).toContain("json");
    expect(config.vitest).toEqual({ configFile: "vitest.mutation.config.ts", related: false });
    expect(config.jsonReporter).toEqual({
      fileName: "reports/mutation/src/lib/money.ts@10-20.json",
    });
    expect(config).toMatchObject({ thresholds: base.thresholds });
    expect(base.thresholds.break).toBe(90);
  });

  test("[TST-013] souhrn počítá skóre jako Stryker a pod 90 % selže", () => {
    const mutant = (status: string, line: number) => ({
      id: String(line),
      mutatorName: "M",
      replacement: "x",
      status,
      location: { start: { line, column: 1 }, end: { line, column: 2 } },
    });
    expect(
      scoreOf([
        mutant("Killed", 1),
        mutant("Timeout", 2),
        mutant("Survived", 3),
        mutant("NoCoverage", 4),
        mutant("Ignored", 5),
        mutant("CompileError", 6),
      ]),
    ).toEqual({ detected: 2, valid: 4, score: 50, survived: 1, noCoverage: 1, ignored: 1 });

    const older = {
      files: { "src/a.ts": { mutants: [mutant("Survived", 1), mutant("Killed", 2)] } },
    };
    const newer = { files: { "src/a.ts": { mutants: [mutant("Killed", 1)] } } };
    const merged = mergeReports([older, newer]);
    expect(merged.get("src/a.ts")!.map((m) => m.status)).toEqual(["Killed", "Killed"]);

    const rows = summarize(merged, ["src/a.ts", "src/b.ts"]);
    expect(rows).toEqual([
      expect.objectContaining({ file: "src/a.ts", score: 100, ok: true }),
      expect.objectContaining({ file: "src/b.ts", score: null, ok: false }),
    ]);
    const low = summarize(new Map([["src/a.ts", [mutant("Killed", 1), mutant("Survived", 2)]]]), [
      "src/a.ts",
    ]);
    expect(low[0]).toMatchObject({ score: 50, ok: false });
  });

  test("[TST-013] rozsahy spuštěné po celém souboru nahradí jeho starou zprávu", () => {
    const whole = { path: "src/a.ts.json", mtimeMs: 1 };
    const first = { path: "src/a.ts@1-50.json", mtimeMs: 2 };
    const second = { path: "src/a.ts@51-99.json", mtimeMs: 3 };
    const other = { path: "src/b.ts.json", mtimeMs: 0 };
    expect(pickReports([second, whole, first, other])).toEqual([
      "src/b.ts.json",
      "src/a.ts@1-50.json",
      "src/a.ts@51-99.json",
    ]);
    expect(pickReports([first, { ...whole, mtimeMs: 4 }])).toEqual(["src/a.ts.json"]);
  });
});
