import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";

// Workers wait on a shared gate so that they all start hitting the database at the same moment.
async function runGatedWorkers<T>(
  script: string,
  resultKey: string,
  jobs: Record<string, unknown>[],
  databasePath: string,
): Promise<T[]> {
  const gate = new SharedArrayBuffer(4);
  const workers = jobs.map(
    (job) =>
      new Worker(new URL(script, import.meta.url), {
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
  const results = workers.map((worker) => message<T>(worker, resultKey));
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

export function runAllocateWorkers<T>(
  jobs: Record<string, unknown>[],
  databasePath: string,
): Promise<T[]> {
  return runGatedWorkers("./allocate-worker.mjs", "allocated", jobs, databasePath);
}

export function runJobWorkers<T>(
  jobs: Record<string, unknown>[],
  databasePath: string,
): Promise<T[]> {
  return runGatedWorkers("./job-worker.mjs", "result", jobs, databasePath);
}

export function runAdvanceWorkers<T>(
  jobs: Record<string, unknown>[],
  databasePath: string,
): Promise<T[]> {
  return runGatedWorkers("./advance-worker.mjs", "converted", jobs, databasePath);
}

export function runDashboardWorkers<T>(
  jobs: Record<string, unknown>[],
  databasePath: string,
): Promise<T[]> {
  return runGatedWorkers("./dashboard-worker.mjs", "dashboards", jobs, databasePath);
}

export type CrashPoint =
  | "after_sending"
  | "after_smtp"
  | "in_run_tx"
  | "in_notice_tx"
  | "after_notice_tx"
  | "in_advance_tx"
  | "after_advance_tx"
  | "in_credit_tx"
  | "in_fx_tx";

// A real process, because a worker thread cannot receive SIGKILL. `now` drives the child's clock.
export function runCrashWorker(input: {
  databasePath: string;
  dataDir: string;
  now: Date;
  killAt: CrashPoint;
  // Issues this document in the child instead of draining the queue.
  issue?: { actor: { userId: string; source: "web" }; invoiceId: string; revision: number };
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./crash-worker.mjs", import.meta.url), {
      execArgv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"],
      silent: true,
      env: {
        ...process.env,
        DATA_DIR: input.dataDir,
        CRASH_DATABASE_PATH: input.databasePath,
        CRASH_NOW: input.now.toISOString(),
        CRASH_AT: input.killAt,
        CRASH_ISSUE: input.issue ? JSON.stringify(input.issue) : "",
      },
    });
    let output = "";
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal === "SIGKILL") resolve();
      else reject(new Error(`Worker nedošel k ${input.killAt}, kód ${code}: ${output}`));
    });
  });
}
