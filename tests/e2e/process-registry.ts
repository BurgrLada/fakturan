import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// R-23: one empty file per running `next start`, named by its PID, in a directory of its own run,
// so a run that ends never reaches the servers of another run on the same machine.
export const REGISTRY_ROOT = join(tmpdir(), "fakturan-e2e-pids");

// Set by globalSetup; workers inherit it and pass it to every server they start.
export const RUN_ENV = "FAKTURAN_E2E_RUN";

// The prefix of every data directory freshApp creates; nothing else on the machine uses it.
export const DATA_DIR_PREFIX = "fakturan-e2e-";

export function currentRun(): string {
  const run = process.env[RUN_ENV];
  if (!run || !/^[\w-]+$/.test(run)) throw new Error(`Chybí platné ${RUN_ENV} z globalSetup`);
  return run;
}

export function registryDir(run = currentRun(), root = REGISTRY_ROOT): string {
  return join(root, run);
}

export function recordProcess(pid: number, dir = registryDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(pid)), "");
}

export function forgetProcess(pid: number, dir = registryDir()): void {
  rmSync(join(dir, String(pid)), { force: true });
}

function nulSeparated(path: string): string[] {
  return readFileSync(path, "utf8").split("\0").filter(Boolean);
}

// A recorded PID may have been reused by an unrelated process, so the PID alone proves nothing.
// Next retitles itself "next-server (vX)", which rewrites cmdline; both forms count.
export function isFakturanNext(pid: number, run = currentRun(), procRoot = "/proc"): boolean {
  try {
    const cmdline = nulSeparated(join(procRoot, String(pid), "cmdline"));
    const environ = nulSeparated(join(procRoot, String(pid), "environ"));
    const value = (name: string) =>
      environ.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
    const runsNext = cmdline.some((arg) => /(^|\/)next(\/|$)|next-server/.test(arg));
    const dataDir = value("DATA_DIR");
    return (
      runsNext &&
      value(RUN_ENV) === run &&
      dataDir !== undefined &&
      basename(dataDir).startsWith(DATA_DIR_PREFIX)
    );
  } catch {
    return false;
  }
}

// Sends SIGTERM to every recorded PID that `isOurs` accepts and clears the whole registry.
export function reapRecorded(dir: string, isOurs: (pid: number) => boolean): number[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const reaped: number[] = [];
  for (const name of names) {
    rmSync(join(dir, name), { force: true });
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!isOurs(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(pid);
    } catch {
      // already gone
    }
  }
  return reaped;
}

export function reapRun(run: string, root = REGISTRY_ROOT, procRoot = "/proc"): number[] {
  const dir = registryDir(run, root);
  const reaped = reapRecorded(dir, (pid) => isFakturanNext(pid, run, procRoot));
  rmSync(dir, { recursive: true, force: true });
  return reaped;
}
