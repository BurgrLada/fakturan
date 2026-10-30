import type { NextRequest } from "next/server";
import { env } from "@/server/env";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { RateLimitError } from "@/server/services/access";
import { exportAuditCsv, parseAuditFilter } from "@/server/services/audit-read";

// POST with an origin check: the export is logged and rate limited, so a cross-site page must not trigger it.
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return new Response(null, { status: 403 });
  if (!(await getCurrentSession())) return new Response(null, { status: 401 });
  const form = await request.formData().catch(() => new FormData());
  const filter = parseAuditFilter(
    Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<
      string,
      string
    >,
  );
  try {
    const csv = exportAuditCsv(await actorFromRequest(), filter);
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="historie-${day}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return new Response(error.message, { status: 429 });
    throw error;
  }
}
