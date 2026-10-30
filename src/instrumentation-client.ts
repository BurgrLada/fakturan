import { DATA_COLLECTION, scrubEvent } from "./server/monitoring/before-send";

// The DSN is fetched at runtime so one image serves every instance; the client SDK loads only when
// a DSN is configured. Envelopes go through /api/monitoring, which keeps the CSP at connect-src 'self'.
async function start() {
  const res = await fetch("/api/monitoring");
  if (!res.ok) return;
  const { dsn } = (await res.json()) as { dsn: string };
  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn,
    tunnel: "/api/monitoring",
    dataCollection: { ...DATA_COLLECTION, httpBodies: [] },
    beforeSend: scrubEvent,
  });
}

start().catch(() => {});
