import { isMailLayout } from "@/lib/mail-look";
import { actorFromRequest } from "@/server/auth/session";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError } from "@/server/services/access";
import { getMailLook, mailLookPreview } from "@/server/services/mail-look";

const reply = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

// The page shows it in a sandboxed iframe; the policy also keeps it inert when opened directly.
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export async function GET(request: Request) {
  const actor = await actorFromRequest();
  if (!actor.userId) return reply(404);
  const asked = new URL(request.url).searchParams.get("layout");
  if (asked !== null && !isMailLayout(asked)) return reply(400);
  try {
    enforceRateLimit(actor, RATE_RULES.pdfPreviewUser);
  } catch (error) {
    if (error instanceof RateLimitError) return reply(429);
    throw error;
  }
  const layout = asked ?? getMailLook(actor.userId).layout;
  return new Response(await mailLookPreview(actor.userId, layout), { headers: HEADERS });
}
