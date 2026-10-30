import * as Sentry from "@sentry/nextjs";
import { DATA_COLLECTION, scrubEvent } from "./src/server/monitoring/before-send";

type Sdk = Pick<typeof Sentry, "init">;

// Read from the runtime environment: one image serves every instance, so nothing is baked in at build time.
export function initMonitoring(source: Record<string, string | undefined>, sdk: Sdk = Sentry) {
  const dsn = source.SENTRY_DSN;
  if (!dsn) return false;
  const rate = Number(source.SENTRY_TRACES_SAMPLE_RATE);
  sdk.init({
    dsn,
    environment: source.SENTRY_ENVIRONMENT || undefined,
    tracesSampleRate: Number.isFinite(rate) && source.SENTRY_TRACES_SAMPLE_RATE ? rate : 0,
    dataCollection: { ...DATA_COLLECTION, httpBodies: [] },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  });
  return true;
}
