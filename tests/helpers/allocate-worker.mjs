// Runs the real service in a worker thread, where vitest's transform and aliases do not apply.
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stub = pathToFileURL(join(root, "tests/helpers/server-only.ts")).href;

function withExtension(path) {
  if (existsSync(`${path}.ts`)) return `${path}.ts`;
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "index.ts") : path;
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: stub, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const path = withExtension(join(root, "src", specifier.slice(2)));
      return { url: pathToFileURL(path).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/")) {
      const path = withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier));
      return { url: pathToFileURL(path).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { databasePath, ownerId, seriesId, date, count, gate } = workerData;

const { createDb, setDbForTests } = await import("@/server/db");
const { mutate } = await import("@/server/services/mutation");
const { allocateNumber } = await import("@/server/services/number-series");

setDbForTests(createDb(databasePath));

const signal = new Int32Array(gate);
parentPort.postMessage({ ready: true });
Atomics.wait(signal, 0, 0);

const allocated = [];
for (let i = 0; i < count; i += 1) {
  allocated.push(
    mutate({ userId: ownerId, source: "web" }, "number_series.test_allocate", (tx, audit) => {
      const result = allocateNumber(tx, ownerId, seriesId, date);
      audit({
        entity: "number_series",
        entityId: seriesId,
        ownerId,
        scope: "user",
        after: result,
      });
      return result;
    }),
  );
}
parentPort.postMessage({ allocated });
