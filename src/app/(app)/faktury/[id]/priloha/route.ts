import { MAX_UPLOAD_BYTES } from "@/lib/import-preview";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { readCapped, ReadTimeout, TooLarge } from "@/server/monitoring/tunnel";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError, ServiceError } from "@/server/services/access";
import { attachImportPdf, ImportPdfRefused } from "@/server/services/files";

const T = TEXTS.importing.imported;
const ID = /^[0-9a-f-]{36}$/;
// A 25 MB PDF over a slow line still has to arrive; the cap, not the clock, bounds the memory.
const READ_TIMEOUT_MS = 120_000;

const reply = (status: number, body: Record<string, unknown> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function nameOf(request: Request): string {
  try {
    return decodeURIComponent(request.headers.get("x-file-name") ?? "");
  } catch {
    return "";
  }
}

// R-12 of plan 9: the raw body like an import upload, outside the server action's 3 MB limit and
// outside the proxy's matcher.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.BETTER_AUTH_URL).origin) return reply(403);
  if (!(await getCurrentSession())) return reply(401);
  const actor = await actorFromRequest();
  const { id } = await params;
  if (!ID.test(id)) return reply(404, { error: TEXTS.invoices.validation.notFound });
  try {
    enforceRateLimit(actor, RATE_RULES.importUser);
    const data = await readCapped(request, MAX_UPLOAD_BYTES, READ_TIMEOUT_MS);
    const { fileId } = attachImportPdf(actor, id, Buffer.from(data), nameOf(request));
    return reply(200, { fileId });
  } catch (error) {
    await request.body?.cancel().catch(() => {});
    if (error instanceof TooLarge) return reply(413, { error: T.pdfTooLarge });
    if (error instanceof ReadTimeout) return reply(408, { error: T.uploadTimeout });
    if (error instanceof RateLimitError) return reply(429, { error: error.message });
    if (error instanceof ImportPdfRefused) return reply(error.status, { error: error.message });
    if (error instanceof ServiceError) {
      const notFound = error.message === TEXTS.invoices.validation.notFound;
      return reply(notFound ? 404 : 422, { error: error.message });
    }
    throw error;
  }
}
