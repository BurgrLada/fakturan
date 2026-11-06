import { describe, expect, test } from "vitest";
import { TEXTS } from "@/lib/texts";
import {
  createMemoryGuard,
  HELD_COSTS,
  lineCost,
  MEMORY_LIMITS,
  RestoreRejected,
  type MemoryProbe,
} from "@/server/backup/memory-guard";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const roomy: MemoryProbe = () => ({ heapUsed: 0, heapLimit: 4 * GiB });

describe("hlídač paměti obnovy", () => {
  test("[SEC-005] meze a ceny hlídače odpovídají rozhodnutí a měření", () => {
    expect(MEMORY_LIMITS).toEqual({
      heldBytes: 640 * MiB,
      heapShare: 0.75,
      everyLines: 1000,
      everyBytes: 4 * MiB,
    });
    expect(HELD_COSTS).toEqual({ id: 210, node: 85, container: 453, textByte: 4 });
    expect(lineCost(1000, { containers: 2, nodes: 10, depth: 1 })).toBe(4000 + 906 + 850);
  });

  test("[SEC-005] evidence nad 640 MiB je odmítnutá hned při zápisu", () => {
    const guard = createMemoryGuard(roomy);
    guard.hold("entry", 400 * MiB);
    guard.hold("ids", 240 * MiB);
    expect(guard.held()).toBe(640 * MiB);
    expect(() => guard.hold("line", 1)).toThrow(RestoreRejected);
  });

  test("[SEC-005] položka se přepisuje a nula ji uvolní", () => {
    const guard = createMemoryGuard(roomy, { heldBytes: 100, heapShare: 1 });
    guard.hold("entry", 90);
    guard.hold("entry", 10);
    guard.hold("line", 80);
    expect(guard.held()).toBe(90);
    guard.hold("line", 0);
    expect(guard.held()).toBe(10);
    expect(guard.peak()).toBe(90);
    expect(() => guard.hold("entry", 101)).toThrow(TEXTS.restore.errors.memory);
  });

  test("[SEC-005] halda nad 75 % limitu je pojistka i bez evidence", () => {
    const limit = 1000 * MiB;
    const under = createMemoryGuard(() => ({ heapUsed: 750 * MiB, heapLimit: limit }));
    expect(() => under.check()).not.toThrow();
    const over = createMemoryGuard(() => ({ heapUsed: 751 * MiB, heapLimit: limit }));
    expect(() => over.check()).toThrow(TEXTS.restore.errors.memory);
  });

  test("[SEC-005] nesesbírané smetí samo o sobě neodmítá", () => {
    // Heap readings that grow by gigabytes while the restore holds little: only the share counts.
    let reading = 0;
    const guard = createMemoryGuard(() => ({
      heapUsed: (reading += 300) * MiB,
      heapLimit: 4 * GiB,
    }));
    guard.hold("entry", 10 * MiB);
    expect(() => guard.check()).not.toThrow();
    expect(() => guard.check()).not.toThrow();
  });

  test("[SEC-005] výchozí sonda čte skutečnou haldu procesu", () => {
    expect(() => createMemoryGuard().check()).not.toThrow();
  });
});
