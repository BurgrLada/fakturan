import { describe, expect, test } from "vitest";
import { TEXTS } from "@/lib/texts";
import {
  createMemoryGuard,
  MEMORY_LIMITS,
  RestoreRejected,
  type MemoryProbe,
} from "@/server/backup/memory-guard";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function probeOf(samples: { heapUsed: number; arrayBuffers?: number; heapLimit?: number }[]) {
  let index = 0;
  const probe: MemoryProbe = () => {
    const sample = samples[Math.min(index, samples.length - 1)]!;
    index += 1;
    return { arrayBuffers: 0, heapLimit: 4 * GiB, ...sample };
  };
  return probe;
}

describe("hlídač paměti obnovy", () => {
  test("[SEC-005] meze hlídače odpovídají plánu", () => {
    expect(MEMORY_LIMITS).toEqual({
      growthBytes: 640 * MiB,
      heapShare: 0.6,
      everyLines: 1000,
      everyBytes: 4 * MiB,
    });
  });

  test("[SEC-005] nárůst nad 640 MiB od začátku je odmítnutý", () => {
    const guard = createMemoryGuard(
      probeOf([{ heapUsed: 100 * MiB }, { heapUsed: 740 * MiB }, { heapUsed: 741 * MiB }]),
    );
    expect(() => guard.check()).not.toThrow();
    expect(() => guard.check()).toThrow(RestoreRejected);
  });

  test("[SEC-005] bajty mimo haldu se počítají do nárůstu", () => {
    const guard = createMemoryGuard(
      probeOf([
        { heapUsed: 100 * MiB, arrayBuffers: 10 * MiB },
        { heapUsed: 400 * MiB, arrayBuffers: 351 * MiB },
      ]),
    );
    expect(() => guard.check()).toThrow(TEXTS.restore.errors.memory);
  });

  test("[SEC-005] halda nad 60 % limitu je odmítnutá i bez nárůstu", () => {
    const limit = 1000 * MiB;
    const under = createMemoryGuard(probeOf([{ heapUsed: 600 * MiB, heapLimit: limit }]));
    expect(() => under.check()).not.toThrow();
    const over = createMemoryGuard(probeOf([{ heapUsed: 601 * MiB, heapLimit: limit }]));
    expect(() => over.check()).toThrow(TEXTS.restore.errors.memory);
  });

  test("[SEC-005] vlastní meze přebijí výchozí", () => {
    const guard = createMemoryGuard(probeOf([{ heapUsed: 0 }, { heapUsed: 11 }]), {
      growthBytes: 10,
      heapShare: 1,
    });
    expect(() => guard.check()).toThrow(RestoreRejected);
  });

  test("[SEC-005] výchozí sonda čte skutečnou paměť procesu", () => {
    expect(() => createMemoryGuard().check()).not.toThrow();
  });
});
