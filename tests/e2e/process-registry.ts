import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// R-23: one empty file per running `next start`, named by its PID, shared by all workers.
export const REGISTRY_DIR = join(tmpdir(), "fakturan-e2e-pids");

// The prefix of every data directory freshApp creates; nothing else on the machine uses it.
export const DATA_DIR_PREFIX = "fakturan-e2e-";

export function recordProcess(pid: number, dir = REGISTRY_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(pid)), "");
}

export function forgetProcess(pid: number, dir = REGISTRY_DIR): void {
  rmSync(join(dir, String(pid)), { force: true });
}

function nulSeparated(path: string): string[] {
  return readFileSync(path, "utf8").split("\0").filter(Boolean);
}

// A recorded PID may have been reused by an unrelated process, so the PID alone proves nothing.
export function isFakturanNext(pid: number, procRoot = "/proc"): boolean {
  try {
    const cmdline = nulSeparated(join(procRoot, String(pid), "cmdline"));
    const environ = nulSeparated(join(procRoot, String(pid), "environ"));
    const runsNext = cmdline.some((arg) => /(^|\/)next(\/|$)|next-server/.test(arg));
    const dataDir = environ.find((entry) => entry.startsWith("DATA_DIR="))?.slice(9);
    return runsNext && dataDir !== undefined && basename(dataDir).startsWith(DATA_DIR_PREFIX);
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
