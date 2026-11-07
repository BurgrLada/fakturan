import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { configName, parseTarget, reportPath, strykerConfig } from "../../scripts/mutation";
import { combineReports, CORE, scoreOf, summarize } from "../../scripts/mutation-summary";

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
    expect(configName({ file: "src/lib/money.ts", range: [10, 20] })).not.toBe(
      configName({ file: "src/lib/money.ts", range: [21, 40] }),
    );
    expect(configName({ file: "src/lib/money.ts", range: null })).toBe(
      "stryker.src_lib_money.ts.json",
    );
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

    const merged = new Map([["src/a.ts", [mutant("Killed", 1), mutant("Killed", 2)]]]);
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

  test("[TST-013] souhrn bere jen zprávy aktuálního zdroje a rozsahy jen přes celý soubor", () => {
    const mutant = (status: string, line: number, replacement = "x") => ({
      mutatorName: "M",
      replacement,
      status,
      location: { start: { line, column: 1 }, end: { line, column: 2 } },
    });
    const source = "a\nb\nc\nd\n";
    const full = {
      range: null,
      mtimeMs: 1,
      source,
      mutants: [mutant("Killed", 1), mutant("Survived", 2), mutant("Survived", 4)],
    };
    const statuses = (list: ReturnType<typeof combineReports>) =>
      list?.map((m) => `${m.location.start.line}:${m.status}`).sort();

    // A newer range overlays the full report only inside its lines.
    const partial = {
      range: [2, 2] as [number, number],
      mtimeMs: 2,
      source,
      mutants: [mutant("Killed", 2)],
    };
    expect(statuses(combineReports(source, [full, partial]))).toEqual([
      "1:Killed",
      "2:Killed",
      "4:Survived",
    ]);

    // Without a full report, a range that leaves lines out is no measurement at all.
    expect(combineReports(source, [partial])).toBeNull();
    const rest = {
      range: [3, 4] as [number, number],
      mtimeMs: 3,
      source,
      mutants: [mutant("Killed", 4)],
    };
    const first = {
      range: [1, 2] as [number, number],
      mtimeMs: 2,
      source,
      mutants: [mutant("Killed", 1)],
    };
    expect(statuses(combineReports(source, [first, rest]))).toEqual(["1:Killed", "4:Killed"]);

    // A report of another source is stale and dropped, with or without a range.
    const stale = { ...full, source: "a\nb\n" };
    expect(combineReports(source, [stale])).toBeNull();
    expect(statuses(combineReports(source, [full, { ...partial, source: "jiný" }]))).toEqual(
      statuses(combineReports(source, [full])),
    );

    // An older range never overrides a newer full report; overlapping ranges keep one result each.
    expect(statuses(combineReports(source, [{ ...partial, mtimeMs: 0 }, full]))).toEqual([
      "1:Killed",
      "2:Survived",
      "4:Survived",
    ]);
    const overlap = {
      range: [1, 3] as [number, number],
      mtimeMs: 4,
      source,
      mutants: [mutant("Killed", 2)],
    };
    expect(statuses(combineReports(source, [first, rest, overlap]))).toEqual([
      "2:Killed",
      "4:Killed",
    ]);

    expect(summarize(new Map(), ["src/a.ts"])[0]).toMatchObject({ score: null, ok: false });
  });

  test("[TST-013] README popisuje běh po souborech, rozsahy, --incremental a bránu jádra", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/pnpm run test:mutation:file -- \S+\.ts\n/);
    expect(readme).toMatch(/pnpm run test:mutation:file -- \S+\.ts:\d+-\d+/);
    expect(readme).toMatch(/pnpm run test:mutation:file -- \S+ --incremental/);
    expect(readme).toContain("pnpm run test:mutation:summary -- --core");
  });
});
