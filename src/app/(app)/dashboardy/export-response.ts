import "server-only";
import type { NextRequest } from "next/server";
import type { DashboardFile } from "@/lib/dashboard-share";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError, ServiceError } from "@/server/services/access";

// POST with an origin check like the report export: a cross-site page must not spend the limit.
export async function dashboardFileResponse(
  request: NextRequest,
  filename: string,
  build: (ownerId: string) => DashboardFile,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return new Response(null, { status: 403 });
  if (!(await getCurrentSession())) return new Response(null, { status: 401 });
  const actor = await actorFromRequest();
  try {
    enforceRateLimit(actor, RATE_RULES.exportUser);
    const file = build(actor.userId!);
    return new Response(`${JSON.stringify(file, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return new Response(error.message, { status: 429 });
    if (error instanceof ServiceError) return new Response(error.message, { status: 404 });
    throw error;
  }
}
