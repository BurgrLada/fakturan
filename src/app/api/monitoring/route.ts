import { connection } from "next/server";
import { clientIp } from "@/server/auth/request-actor";
import { env } from "@/server/env";
import { publicDsn } from "@/server/monitoring/dsn";
import { readCapped, relayEnvelope, TooLarge } from "@/server/monitoring/tunnel";
import { checkRateLimit, RATE_RULES } from "@/server/rate-limit";

// Same-origin tunnel: CSP stays at connect-src 'self' whichever Sentry-compatible host an instance uses.
export async function GET() {
  await connection();
  const dsn = process.env.SENTRY_DSN && publicDsn(process.env.SENTRY_DSN);
  if (!dsn) return new Response(null, { status: 404 });
  return Response.json(
    { dsn, environment: process.env.SENTRY_ENVIRONMENT || undefined },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  await connection();
  if (!process.env.SENTRY_DSN) return new Response(null, { status: 404 });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(env.BETTER_AUTH_URL).origin) {
    return new Response(null, { status: 403 });
  }
  const ip = clientIp(request.headers, env) ?? "unknown";
  const limit = checkRateLimit(ip, RATE_RULES.monitoringIp);
  if (!limit.allowed) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }
  let body: Uint8Array;
  try {
    body = await readCapped(request);
  } catch (err) {
    return new Response(null, { status: err instanceof TooLarge ? 413 : 400 });
  }
  const res = await relayEnvelope(body, process.env.SENTRY_DSN);
  return new Response(null, { status: res.ok ? 200 : res.status });
}
