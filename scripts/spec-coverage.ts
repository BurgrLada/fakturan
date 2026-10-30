import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const specPath = join(root, "docs/superpowers/specs/2026-10-30-fakturan-design.md");
const pendingPath = join(root, "tests/spec-pending.txt");
const testsDir = join(root, "tests");

export function extractSpecIds(markdown: string): string[] {
  const ids = [...markdown.matchAll(/\*\*([A-Z]{2,4}-\d{3})\*\*/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

export function extractTestedIds(source: string): string[] {
  const titles = source.matchAll(
    /\b(?:test|it|describe)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g,
  );
  const ids = [...titles].flatMap((m) => [...m[2].matchAll(/\[([A-Z]{2,4}-\d{3})\]/g)]);
  return [...new Set(ids.map((m) => m[1]))];
}

export function findMissing(input: {
  specIds: string[];
  tested: string[];
  pending: string[];
}): string[] {
  const covered = new Set([...input.tested, ...input.pending]);
  return input.specIds.filter((id) => !covered.has(id));
}

export function findStalePending(input: { tested: string[]; pending: string[] }): string[] {
  const tested = new Set(input.tested);
  return input.pending.filter((id) => tested.has(id));
}

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return testFiles(path);
    return /\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

function readPending(): string[] {
  return readFileSync(pendingPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function main() {
  const specIds = extractSpecIds(readFileSync(specPath, "utf8"));
  const tested = [
    ...new Set(testFiles(testsDir).flatMap((f) => extractTestedIds(readFileSync(f, "utf8")))),
  ];

  if (process.argv.includes("--write-pending")) {
    const covered = new Set(tested);
    const pending = specIds.filter((id) => !covered.has(id));
    writeFileSync(pendingPath, pending.map((id) => `${id}\n`).join(""));
    console.log(`spec-pending.txt: ${pending.length} ID`);
    return;
  }

  const pending = readPending();
  const missing = findMissing({ specIds, tested, pending });
  const stale = findStalePending({ tested, pending });
  if (missing.length) console.error(`ID bez testu: ${missing.join(", ")}`);
  if (stale.length) console.error(`ID s testem je stále v spec-pending.txt: ${stale.join(", ")}`);
  if (missing.length || stale.length) process.exit(1);
  console.log(`OK: ${specIds.length} ID, ${pending.length} čeká na test`);
}

if (import.meta.filename === process.argv[1]) main();
