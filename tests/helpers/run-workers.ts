import { Worker } from "node:worker_threads";

// Workers wait on a shared gate so that they all start hitting the database at the same moment.
export async function runAllocateWorkers<T>(
  jobs: Record<string, unknown>[],
  databasePath: string,
): Promise<T[]> {
  const gate = new SharedArrayBuffer(4);
  const workers = jobs.map(
    (job) =>
      new Worker(new URL("./allocate-worker.mjs", import.meta.url), {
        execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
        workerData: { ...job, databasePath, gate },
      }),
  );
  const failure = (worker: Worker) =>
    new Promise<never>((_, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Worker skončil s kódem ${code}`)));
    });
  const message = <M>(worker: Worker, key: string) =>
    Promise.race([
      new Promise<M>((resolve) => {
        worker.on("message", (received) => {
          if (key in received) resolve(received[key]);
        });
      }),
      failure(worker),
    ]);
  const ready = workers.map((worker) => message<boolean>(worker, "ready"));
  const results = workers.map((worker) => message<T>(worker, "allocated"));
  // A rejection before the gate opens must surface through `ready`, not as an unhandled one.
  void Promise.allSettled(results);

  try {
    await Promise.all(ready);
    const signal = new Int32Array(gate);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
