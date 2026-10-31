import "server-only";
import * as Sentry from "@sentry/nextjs";
import { logger } from "../logger";
import { scrubText } from "../monitoring/before-send";

type FailureContext = { task: string; jobId?: string; kind?: string; userId?: string };

// For code failures only: a client's failing SMTP is a notice to the user, not an error (R-30).
export function reportFailure(error: unknown, ctx: FailureContext): void {
  const { task, jobId, kind, userId } = ctx;
  const [name, message] =
    error instanceof Error ? [error.name, error.message] : ["", String(error)];
  logger.error("selhání plánovače", { ...ctx, error: { name, message: scrubText(message) } });
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureException(error, {
    tags: { task, ...(kind ? { kind } : {}), ...(jobId ? { job_id: jobId } : {}) },
    ...(userId ? { user: { id: userId } } : {}),
  });
}
