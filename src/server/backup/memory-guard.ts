import "server-only";
import v8 from "node:v8";
import type { JsonShape } from "@/lib/backup-format";
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

export type MemoryProbe = () => { heapUsed: number; heapLimit: number };

// R-3 as ruled: the bound is what the run itself holds, counted item by item, because heap
// readings include garbage V8 has not collected yet and would refuse a legitimate account. The
// heap share is only a backstop. Counts of lines, bytes and JSON nodes are a cheap prefilter.
export const MEMORY_LIMITS = {
  heldBytes: 640 * MiB,
  heapShare: 0.75,
  everyLines: 1000,
  everyBytes: 4 * MiB,
};

// Bytes of heap per item, measured on Node 24 (plan 8 re-review and tasks 1 and 2 of plan 9): an
// id in the id map with its old key, a blob listed in files.jsonl with what a pass keeps of it, a
// JSON value with a unique key, an object, and a byte of two-byte text at its peak while a copy is
// made.
export const HELD_COSTS = { id: 210, file: 400, node: 85, container: 453, textByte: 4 };

export function lineCost(bytes: number, shape: JsonShape): number {
  return (
    bytes * HELD_COSTS.textByte +
    shape.containers * HELD_COSTS.container +
    shape.nodes * HELD_COSTS.node
  );
}

const processProbe: MemoryProbe = () => {
  const { used_heap_size, heap_size_limit } = v8.getHeapStatistics();
  return { heapUsed: used_heap_size, heapLimit: heap_size_limit };
};

export type MemoryGuard = {
  // Sets what one named item holds now; 0 releases it. Refuses at once above the limit.
  hold(item: string, bytes: number): void;
  check(): void;
  held(): number;
  peak(): number;
};

export function createMemoryGuard(
  probe: MemoryProbe = processProbe,
  limits: { heldBytes: number; heapShare: number } = MEMORY_LIMITS,
): MemoryGuard {
  const items = new Map<string, number>();
  let total = 0;
  let peak = 0;
  const refuse = () => new RestoreRejected(TEXTS.restore.errors.memory);
  return {
    hold(item, bytes) {
      total += bytes - (items.get(item) ?? 0);
      if (bytes > 0) items.set(item, bytes);
      else items.delete(item);
      peak = Math.max(peak, total);
      if (total > limits.heldBytes) throw refuse();
    },
    check() {
      if (total > limits.heldBytes) throw refuse();
      const now = probe();
      if (now.heapUsed > limits.heapShare * now.heapLimit) throw refuse();
    },
    held: () => total,
    peak: () => peak,
  };
}
