import "server-only";
import v8 from "node:v8";
import { TEXTS } from "@/lib/texts";

const MiB = 1024 * 1024;

// The message is shown to the person; it names at most a table of the registry, never a value or
// an entry name from the archive.
export class RestoreRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRejected";
  }
}

export type MemoryProbe = () => { heapUsed: number; arrayBuffers: number; heapLimit: number };

// R-3: counts of lines, bytes and JSON nodes are only a cheap prefilter; this is the real bound.
// Growth is measured from the start of the run, so the rest of the process does not count.
export const MEMORY_LIMITS = {
  growthBytes: 640 * MiB,
  heapShare: 0.6,
  everyLines: 1000,
  everyBytes: 4 * MiB,
};

const processProbe: MemoryProbe = () => {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return { heapUsed, arrayBuffers, heapLimit: v8.getHeapStatistics().heap_size_limit };
};

export type MemoryGuard = { check(): void };

export function createMemoryGuard(
  probe: MemoryProbe = processProbe,
  limits: { growthBytes: number; heapShare: number } = MEMORY_LIMITS,
): MemoryGuard {
  const start = probe();
  const base = start.heapUsed + start.arrayBuffers;
  return {
    check() {
      const now = probe();
      if (
        now.heapUsed + now.arrayBuffers - base > limits.growthBytes ||
        now.heapUsed > limits.heapShare * now.heapLimit
      ) {
        throw new RestoreRejected(TEXTS.restore.errors.memory);
      }
    },
  };
}
