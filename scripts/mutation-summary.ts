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
export type Report = { files: Record<string, { mutants: Mutant[] }> };

const key = (m: Mutant) =>
  `${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement ?? ""}`;

type Entry = { path: string; mtimeMs: number };

// Per source file either the newest whole-file report, or, when ranges ran after it, only the range
// reports: their line numbers come from newer code, so the old report's mutants would not match.
export function pickReports(entries: Entry[]): string[] {
  const bySource = new Map<string, Entry[]>();
  for (const entry of entries) {
    const source = entry.path.replace(/(@\d+-\d+)?\.json$/, "");
    bySource.set(source, [...(bySource.get(source) ?? []), entry]);
  }
  const picked: Entry[] = [];
  for (const group of bySource.values()) {
    const whole = group.find((e) => !e.path.includes("@"));
    const ranges = group.filter((e) => e.path.includes("@") && e.mtimeMs > (whole?.mtimeMs ?? -1));
    picked.push(...(ranges.length > 0 ? ranges : whole ? [whole] : []));
  }
  return picked.sort((a, b) => a.mtimeMs - b.mtimeMs).map((e) => e.path);
}

// Reports in age order: a later run of the same mutant replaces the earlier result.
export function mergeReports(reports: Report[]): Map<string, Mutant[]> {
  const files = new Map<string, Map<string, Mutant>>();
  for (const report of reports) {
    for (const [file, { mutants }] of Object.entries(report.files)) {
      const byKey = files.get(file) ?? new Map<string, Mutant>();
      for (const mutant of mutants) byKey.set(key(mutant), mutant);
      files.set(file, byKey);
    }
  }
  return new Map([...files].map(([file, byKey]) => [file, [...byKey.values()]]));
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
  const entries = existsSync(dir)
    ? globSync("**/*.ts*.json", { cwd: dir })
        .filter((p) => !p.endsWith(".incremental.json"))
        .map((p) => ({ path: p, mtimeMs: statSync(join(dir, p)).mtimeMs }))
    : [];
  const paths = pickReports(entries).map((p) => join(dir, p));
  const merged = mergeReports(paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as Report));
  const rows = summarize(merged, files);
  const pad = Math.max(...rows.map((r) => r.file.length));
  console.log(`${"soubor".padEnd(pad)}  skóre   zabito  platné  přežilo  bez pokrytí  ignorováno`);
  for (const r of rows) {
    const score = r.score === null ? "neměřeno" : `${r.score.toFixed(2)} %`;
    console.log(
      `${r.file.padEnd(pad)}  ${score.padStart(8)}  ${String(r.detected).padStart(6)}  ${String(r.valid).padStart(6)}  ${String(r.survived).padStart(7)}  ${String(r.noCoverage).padStart(11)}  ${String(r.ignored).padStart(10)}${r.ok ? "" : "  ← pod 90 %"}`,
    );
  }
  return rows.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
