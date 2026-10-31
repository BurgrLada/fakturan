import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("./server/logger");
  try {
    // Fails fast on missing or malformed configuration, ENCRYPTION_KEY included (SEC-003).
    const { parseEnv } = await import("./server/env");
    parseEnv(process.env);
    const { db, runMigrations } = await import("./server/db");
    runMigrations(db);
    const { startScheduler } = await import("./server/scheduler/start");
    startScheduler();
  } catch (err) {
    logger.error("start selhal", { err });
    // The standalone server survives a failing register() and answers 500; a supervisor needs the exit.
    if (process.env.NODE_ENV === "production") process.exit(1);
    throw err;
  }
  const { initMonitoring } = await import("../sentry.server.config");
  initMonitoring(process.env);
  const trusted = ["1", "true"].includes(process.env.TRUST_PROXY ?? "");
  if (process.env.NODE_ENV === "production" && !trusted) {
    logger.warn(
      "TRUST_PROXY není nastaveno: všichni klienti sdílejí jeden bucket rate limitu. Za reverzní proxy nastavte TRUST_PROXY=1.",
    );
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
