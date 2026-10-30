import { connection } from "next/server";
import { relayEnvelope } from "@/server/monitoring/tunnel";

// Same-origin tunnel: CSP stays at connect-src 'self' whichever Sentry-compatible host an instance uses.
export async function GET() {
  await connection();
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return new Response(null, { status: 404 });
  return Response.json({ dsn }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  await connection();
  const res = await relayEnvelope(await request.text(), process.env.SENTRY_DSN);
  return new Response(null, { status: res.ok ? 200 : res.status });
}
