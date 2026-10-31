// Runs the real queue in a worker thread, where vitest's transform and aliases do not apply.
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

const { databasePath, gate, mode, worker, ticks } = workerData;

const { createDb, db, setDbForTests } = await import("@/server/db");
const { claimNext, completeJob, enqueue } = await import("@/server/jobs/queue");
const { registerJob } = await import("@/server/jobs/registry");
const { registerTickTask, tick } = await import("@/server/scheduler/tick");

setDbForTests(createDb(databasePath));

let runs = 0;
registerJob("mail.send", { run: async () => {} });
registerTickTask({
  name: "denní",
  run: () => {
    runs += 1;
    db.transaction((tx) => {
      enqueue(tx, { kind: "mail.send", key: "daily:2026-11-02", userId: null, payload: {} });
      enqueue(tx, { kind: "mail.send", key: `run:${worker}:${runs}`, userId: null, payload: {} });
    });
  },
});

const signal = new Int32Array(gate);
parentPort.postMessage({ ready: true });
Atomics.wait(signal, 0, 0);

function claimAll() {
  const ids = [];
  for (let next = claimNext(worker); next; next = claimNext(worker)) {
    ids.push(next.id);
    completeJob(next.id, worker);
  }
  return ids;
}

async function tickRepeatedly() {
  const results = [];
  for (let i = 0; i < ticks; i += 1) results.push(await tick(worker));
  return results;
}

parentPort.postMessage({ result: mode === "claim" ? claimAll() : await tickRepeatedly() });
