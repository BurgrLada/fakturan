import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const THRESHOLD = 90;

// R-26: these must reach the threshold; the plan-8 modules in mutate may stay partial.
export const CORE = [
  "src/lib/money.ts",
  "src/lib/number-format.ts",
  "src/lib/invoice-totals.ts",
  "src/lib/qr-payload.ts",
  "src/lib/bank-notices/index.ts",
  "src/lib/bank-notices/fio.ts",
  "src/lib/bank-notices/auth.ts",
  "src/lib/bank-notices/mask.ts",
  "src/lib/payments.ts",
  "src/lib/payment-matching.ts",
  "src/lib/recurrence.ts",
  "src/lib/czech-holidays.ts",
  "src/lib/fx.ts",
  "src/lib/cnb-rates.ts",
  "src/server/jobs/queue.ts",
  "src/server/scheduler/lease.ts",
  "src/server/scheduler/tick.ts",
  "src/server/services/number-series.ts",
];

export type Mutant = {
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
};
export type Report = { files: Record<string, { source?: string; mutants: Mutant[] }> };

const key = (m: Mutant) =>
  `${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement ?? ""}`;

export type ReportEntry = {
  range: [number, number] | null;
  mtimeMs: number;
  source: string | undefined;
  mutants: Mutant[];
};

function lineCount(source: string): number {
  const lines = source.split("\n").length;
  return source.endsWith("\n") ? lines - 1 : lines;
}

function covers(ranges: [number, number][], last: number): boolean {
  let reached = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from > reached + 1) return false;
    reached = Math.max(reached, to);
  }
  return reached >= last;
}

// A report only counts for the source it measured. Range reports newer than the newest full report
// replace its mutants inside their lines; without a full report they must cover the whole file.
// Null means no valid measurement, which the gate treats as a failure.
export function combineReports(source: string, entries: ReportEntry[]): Mutant[] | null {
  // A missing or empty file (such as a CORE entry left behind by a rename) has nothing measured.
  if (source.trim() === "" || lineCount(source) === 0) return null;
  const valid = entries
    .filter((entry) => entry.source === source)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const base = valid.filter((entry) => entry.range === null).at(-1);
  const ranges = valid.filter(
    (entry) => entry.range !== null && entry.mtimeMs > (base?.mtimeMs ?? -Infinity),
  );
  if (
    !base &&
    !covers(
      ranges.map((entry) => entry.range!),
      lineCount(source),
    )
  )
    return null;
  const byKey = new Map((base?.mutants ?? []).map((m) => [key(m), m]));
  for (const { range, mutants } of ranges) {
    const [from, to] = range!;
    for (const [k, m] of byKey) {
      if (m.location.start.line >= from && m.location.start.line <= to) byKey.delete(k);
    }
    for (const m of mutants) byKey.set(key(m), m);
  }
  return [...byKey.values()];
}

export function scoreOf(mutants: Pick<Mutant, "status">[]) {
  const count = (status: string) => mutants.filter((m) => m.status === status).length;
  const detected = count("Killed") + count("Timeout");
  const survived = count("Survived");
  const noCoverage = count("NoCoverage");
  const valid = detected + survived + noCoverage;
  const score = valid === 0 ? 100 : Math.floor((detected / valid) * 10_000) / 100;
  return { detected, valid, score, survived, noCoverage, ignored: count("Ignored") };
}

export type Row = ReturnType<typeof scoreOf> & { file: string; ok: boolean };

export function summarize(
  merged: Map<string, Mutant[]>,
  files: string[],
): (Omit<Row, "score"> & { score: number | null })[] {
  return files.map((file) => {
    const mutants = merged.get(file);
    if (!mutants) {
      return {
        file,
        detected: 0,
        valid: 0,
        survived: 0,
        noCoverage: 0,
        ignored: 0,
        score: null,
        ok: false,
      };
    }
    const result = scoreOf(mutants);
    return { file, ...result, ok: result.score >= THRESHOLD };
  });
}

function main(argv: string[]): number {
  const args = argv.filter((a) => a !== "--");
  const config = JSON.parse(readFileSync(join(root, "stryker.config.json"), "utf8"));
  const all = (config.mutate as string[]).flatMap((p) => globSync(p, { cwd: root })).sort();
  const files = args.includes("--core")
    ? CORE
    : args.length > 0
      ? all.filter((file) => args.some((prefix) => file.startsWith(prefix)))
      : all;
  const dir = join(root, "reports/mutation");
  const byFile = new Map<string, ReportEntry[]>();
  const paths = existsSync(dir)
    ? globSync("**/*.ts*.json", { cwd: dir }).filter((p) => !p.endsWith(".incremental.json"))
    : [];
  for (const path of paths) {
    const match = /^(.+\.ts)(?:@(\d+)-(\d+))?\.json$/.exec(path);
    if (!match) continue;
    const report = JSON.parse(readFileSync(join(dir, path), "utf8")) as Report;
    const measured = report.files[match[1]!];
    if (!measured) continue;
    byFile.set(match[1]!, [
      ...(byFile.get(match[1]!) ?? []),
      {
        range: match[2] ? [Number(match[2]), Number(match[3])] : null,
        mtimeMs: statSync(join(dir, path)).mtimeMs,
        source: measured.source,
        mutants: measured.mutants,
      },
    ]);
  }
  const merged = new Map<string, Mutant[]>();
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    const mutants = combineReports(readFileSync(join(root, file), "utf8"), byFile.get(file) ?? []);
    if (mutants) merged.set(file, mutants);
  }
  const rows = summarize(merged, files);
  const pad = Math.max(...rows.map((r) => r.file.length));
  console.log(`${"soubor".padEnd(pad)}  skóre   zabito  platné  přežilo  bez pokrytí  ignorováno`);
  for (const r of rows) {
    const score = r.score === null ? "neměřeno/zastaralé" : `${r.score.toFixed(2)} %`;
    console.log(
      `${r.file.padEnd(pad)}  ${score.padStart(8)}  ${String(r.detected).padStart(6)}  ${String(r.valid).padStart(6)}  ${String(r.survived).padStart(7)}  ${String(r.noCoverage).padStart(11)}  ${String(r.ignored).padStart(10)}${r.ok ? "" : "  ← pod 90 %"}`,
    );
  }
  return rows.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
