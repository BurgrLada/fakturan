import { z } from "zod";
import { contentDisposition } from "@/lib/content-disposition";
import { MAX_BULK_DOCUMENTS } from "@/lib/invoice";
import { actorFromRequest } from "@/server/auth/session";
import { env } from "@/server/env";
import { RateLimitError, ServiceError } from "@/server/services/access";
import { invoicesZip, InvoicePdfNotFoundError } from "@/server/services/invoice-pdf";
import { emptyResponse } from "@/server/services/pdf-http";

const input = z.object({ ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_DOCUMENTS) });

// POST with an origin check: the export is logged and rate limited, so a cross-site page must not trigger it.
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(env.BETTER_AUTH_URL).origin)
    return emptyResponse(403);
  const actor = await actorFromRequest();
  if (!actor.userId) return emptyResponse(404);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return emptyResponse(400);
  try {
    const { data, fileName } = await invoicesZip(actor, parsed.data.ids);
    return new Response(data, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(data.length),
        "Content-Disposition": contentDisposition("attachment", fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof InvoicePdfNotFoundError) return emptyResponse(404);
    if (error instanceof RateLimitError) return emptyResponse(429);
    if (error instanceof ServiceError) return emptyResponse(400);
    throw error;
  }
}
