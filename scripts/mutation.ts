import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");

export type Target = { file: string; range: [number, number] | null };

export function parseTarget(arg: string): Target {
  const match = /^(.+?\.ts)(?::(\d+)-(\d+))?$/.exec(arg);
  if (!match) throw new Error(`Neplatný cíl: ${arg} (čekám <soubor>[:<od>-<do>])`);
  if (match[2] === undefined) return { file: match[1], range: null };
  const range: [number, number] = [Number(match[2]), Number(match[3])];
  if (range[0] < 1 || range[1] < range[0]) throw new Error(`Neplatný rozsah: ${arg}`);
  return { file: match[1], range };
}

export function reportPath(target: Target): string {
  const suffix = target.range ? `@${target.range[0]}-${target.range[1]}` : "";
  return `reports/mutation/${target.file}${suffix}.json`;
}

type BaseConfig = Record<string, unknown>;

export function strykerConfig(base: BaseConfig, target: Target) {
  const name = reportPath(target);
  return {
    ...base,
    $schema: undefined,
    mutate: [target.range ? `${target.file}:${target.range[0]}-${target.range[1]}` : target.file],
    // Not Stryker's testFiles: with it, 10.1 runs static mutants as runtime ones, so they never activate.
    vitest: { configFile: "vitest.mutation.config.ts", related: false },
    reporters: ["clear-text", "progress", "json"],
    jsonReporter: { fileName: name },
    // Opt in with --incremental: it reuses earlier results, also for static mutants it cannot diff.
    incrementalFile: name.replace(/\.json$/, ".incremental.json"),
  };
}

function main(argv: string[]): number {
  const [arg, ...rest] = argv.filter((a) => a !== "--");
  if (!arg) {
    console.error("Použití: pnpm run test:mutation:file -- <soubor>[:<od>-<do>] [volby strykeru]");
    return 2;
  }
  const target = parseTarget(arg);
  const map: Record<string, string[]> = JSON.parse(
    readFileSync(join(root, "stryker.map.json"), "utf8"),
  );
  const tests = map[target.file];
  if (!tests) {
    console.error(`${target.file} není ve stryker.map.json`);
    return 2;
  }
  const base = JSON.parse(readFileSync(join(root, "stryker.config.json"), "utf8"));
  const config = strykerConfig(base, target);
  const configDir = join(root, ".stryker-tmp");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, `stryker.${target.file.replaceAll("/", "_")}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const report = join(root, reportPath(target));
  mkdirSync(dirname(report), { recursive: true });
  const stryker = join(root, "node_modules/@stryker-mutator/core/bin/stryker.js");
  const run = spawnSync(process.execPath, [stryker, "run", configPath, ...rest], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, MUTATION_TEST_FILES: tests.join(",") },
  });
  rmSync(configPath, { force: true });
  return run.status ?? 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
