import type { NextRequest } from "next/server";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { exportAuditCsv, parseAuditFilter } from "@/server/services/audit-read";

export async function GET(request: NextRequest) {
  if (!(await getCurrentSession())) return new Response(null, { status: 401 });
  const filter = parseAuditFilter(Object.fromEntries(request.nextUrl.searchParams));
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
    if (error instanceof ServiceError) return new Response(error.message, { status: 429 });
    throw error;
  }
}
