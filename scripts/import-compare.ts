// TST-020: node scripts/import-compare.ts <soubor.zip|.isdoc|.pdf> <kopie.sqlite> [id účtu]
// Runs locally against a copy of the database and prints counts and sums per year and currency;
// it writes nothing and must never be run against real invoices inside the repository (R-37).
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function withExtension(path: string): string {
  if (existsSync(`${path}.ts`)) return `${path}.ts`;
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "index.ts") : path;
}

// Node strips the types but knows neither the @/ alias nor imports without an extension.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return {
        url: pathToFileURL(join(root, "tests/helpers/server-only.ts")).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/")) {
      return {
        url: pathToFileURL(withExtension(join(root, "src", specifier.slice(2)))).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/")) {
      const parent = dirname(fileURLToPath(context.parentURL));
      return {
        url: pathToFileURL(withExtension(join(parent, specifier))).href,
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});

const [file, database, ownerId] = process.argv.slice(2);
if (!file || !database) {
  console.error("Použití: node scripts/import-compare.ts <soubor> <kopie.sqlite> [id účtu]");
  process.exit(2);
}
// A runtime path: the type checker does not accept the extension Node needs here.
const corePath = "./import-compare-core.ts";
const { databaseTotals, formatComparison, sourceTotals } = (await import(
  corePath
)) as typeof import("./import-compare-core");
const source = await sourceTotals(new Uint8Array(readFileSync(file)));
console.log(formatComparison(source, databaseTotals(database, ownerId)));
