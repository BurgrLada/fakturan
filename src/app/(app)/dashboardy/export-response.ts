import "server-only";
import type { NextRequest } from "next/server";
import type { DashboardFile } from "@/lib/dashboard-share";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "@/server/audit/context";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { RateLimitError, ServiceError } from "@/server/services/access";

const E = TEXTS.dashboard.errors;
const MISSING: string[] = [E.notFound, E.widgetNotFound];

// POST with an origin check like the report export: a cross-site page must not spend the limit.
export async function dashboardFileResponse(
  request: NextRequest,
  filename: string,
  build: (actor: Actor) => DashboardFile,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return new Response(null, { status: 403 });
  if (!(await getCurrentSession())) return new Response(null, { status: 401 });
  try {
    const file = build(await actorFromRequest());
    return new Response(`${JSON.stringify(file, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return new Response(error.message, { status: 429 });
    if (error instanceof ServiceError) {
      const status = MISSING.includes(error.message) ? 404 : 422;
      return new Response(error.message, { status });
    }
    throw error;
  }
}
