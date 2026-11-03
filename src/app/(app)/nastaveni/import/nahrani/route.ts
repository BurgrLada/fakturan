import { TEXTS } from "@/lib/texts";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError, ServiceError } from "@/server/services/access";
import { storeUpload, UploadTooLarge } from "@/server/services/import-batch";

const E = TEXTS.importing.errors;
const ID = /^[0-9a-f-]{36}$/;

const reply = (status: number, body: Record<string, unknown> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function declared(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nameOf(request: Request): string {
  try {
    return decodeURIComponent(request.headers.get("x-file-name") ?? "");
  } catch {
    return "";
  }
}

// R-7: the raw body goes straight to disk. Server actions would buffer it under their 3 MB limit,
// and the proxy would cut it at 10 MB, so this path is matched by neither.
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return reply(403);
  if (!(await getCurrentSession())) return reply(401);
  const actor = await actorFromRequest();
  const batchId = new URL(request.url).searchParams.get("davka") ?? "";
  if (!ID.test(batchId)) return reply(404, { error: E.notFound });
  try {
    enforceRateLimit(actor, RATE_RULES.importUser);
    const { fileId } = await storeUpload(actor, batchId, request.body, {
      name: nameOf(request),
      declaredBytes: declared(request),
    });
    return reply(200, { fileId });
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    if (error instanceof UploadTooLarge) return reply(413, { error: E.tooLarge });
    if (error instanceof RateLimitError) return reply(429, { error: error.message });
    if (error instanceof ServiceError) {
      return reply(error.message === E.notFound ? 404 : 422, { error: error.message });
    }
    throw error;
  }
}
