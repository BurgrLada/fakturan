import "server-only";
import type { Job, JobKind } from "../db/schema";

export type JobDefinition = {
  run: (job: Job) => Promise<void>;
  recover?: (job: Job) => void;
};

export class RetryLater extends Error {
  delayMs: number;
  // Off by default: a failing provider is an operational state, not a code failure (R-30).
  report: boolean;

  constructor(message: string, delayMs: number, options: { report?: boolean } = {}) {
    super(message);
    this.name = "RetryLater";
    this.delayMs = delayMs;
    this.report = options.report ?? false;
  }
}

const definitions = new Map<string, JobDefinition>();

// Next.js bundles instrumentation apart from the app, and only that graph runs jobs: call this from
// src/server/scheduler/start.ts, not from a module loaded by a route.
export function registerJob(kind: JobKind, definition: JobDefinition): void {
  definitions.set(kind, definition);
}

export function jobDefinition(kind: string): JobDefinition | undefined {
  return definitions.get(kind);
}
