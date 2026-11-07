export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

let override: Clock | null = null;

export const clock: Clock = { now: () => (override ?? systemClock).now() };

export function setClockForTests(c: Clock | null): void {
  override = c;
}

// Synchronous only: an await inside would leak the shifted time into unrelated requests.
export function runAt<T>(at: Date, fn: () => T): T {
  const previous = override;
  override = { now: () => at };
  try {
    const result = fn();
    if (typeof (result as { then?: unknown } | null)?.then === "function") {
      throw new Error("runAt nesmí být asynchronní");
    }
    return result;
  } finally {
    override = previous;
  }
}
