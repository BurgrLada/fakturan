import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const specPath = join(root, "docs/superpowers/specs/2026-10-30-fakturan-design.md");
const pendingPath = join(root, "tests/spec-pending.txt");
const partialPath = join(root, "tests/spec-partial.txt");
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

export type PartialEntry = { id: string; missing: string; plan: string };

export function parsePartial(source: string): { entries: PartialEntry[]; malformed: string[] } {
  const entries: PartialEntry[] = [];
  const malformed: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [id, missing, plan, ...rest] = line.split("\t").map((part) => part.trim());
    if (id && missing && plan && rest.length === 0) entries.push({ id, missing, plan });
    else malformed.push(line);
  }
  return { entries, malformed };
}

export function findUnknownPartial(input: {
  specIds: string[];
  partial: PartialEntry[];
}): string[] {
  const known = new Set(input.specIds);
  return input.partial.map((entry) => entry.id).filter((id) => !known.has(id));
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
  const { entries: partial, malformed } = parsePartial(readFileSync(partialPath, "utf8"));
  const unknown = findUnknownPartial({ specIds, partial });
  if (missing.length) console.error(`ID bez testu: ${missing.join(", ")}`);
  if (stale.length) console.error(`ID s testem je stále v spec-pending.txt: ${stale.join(", ")}`);
  if (unknown.length) console.error(`Neznámé ID v spec-partial.txt: ${unknown.join(", ")}`);
  if (malformed.length) console.error(`Vadné řádky spec-partial.txt:\n${malformed.join("\n")}`);
  if (missing.length || stale.length || unknown.length || malformed.length) process.exit(1);
  console.log(
    `OK: ${specIds.length} ID, ${pending.length} čeká na test, ${partial.length} částečně`,
  );
  for (const { id, missing: gap, plan } of partial) console.log(`  ${id}: ${gap} (${plan})`);
}

if (import.meta.filename === process.argv[1]) main();
