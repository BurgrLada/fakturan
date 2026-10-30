import { DATA_COLLECTION, scrubEvent } from "@/server/monitoring/before-send";

type Sdk = typeof import("@sentry/nextjs");

let started: Promise<Sdk | null> | undefined;

// The DSN is fetched at runtime so one image serves every instance; the SDK loads only when a DSN
// is configured. Envelopes go through /api/monitoring, which keeps the CSP at connect-src 'self'.
async function start(): Promise<Sdk | null> {
  try {
    const res = await fetch("/api/monitoring");
    if (!res.ok) return null;
    const { dsn, environment } = (await res.json()) as { dsn: string; environment?: string };
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn,
      environment,
      tunnel: "/api/monitoring",
      dataCollection: { ...DATA_COLLECTION, httpBodies: [] },
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubEvent,
    });
    return Sentry;
  } catch {
    return null;
  }
}

export function monitoring(): Promise<Sdk | null> {
  started ??= start();
  return started;
}

export function reportClientError(error: unknown): void {
  void monitoring().then((sentry) => sentry?.captureException(error));
}

export function identifyClientUser(id: string): void {
  void monitoring().then((sentry) => sentry?.setUser({ id }));
}
