export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

let override: Clock | null = null;

export const clock: Clock = { now: () => (override ?? systemClock).now() };

export function setClockForTests(c: Clock | null): void {
  override = c;
}
