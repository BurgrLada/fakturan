import { z } from "zod";
import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError } from "@/server/services/access";
import { designPreviewPdf, type PreviewAppearance } from "@/server/services/design-preview";
import {
  colorSchema,
  getPreferences,
  knownDesignIdSchema,
  logoPositionSchema,
} from "@/server/services/preferences";

const querySchema = z.object({
  design: knownDesignIdSchema.optional(),
  accent: colorSchema.optional(),
  surface: colorSchema.optional(),
  text: colorSchema.optional(),
  line: colorSchema.optional(),
  logo: logoPositionSchema.optional(),
});

const empty = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  const actor = await actorFromRequest();
  if (!actor.userId) return empty(404);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return empty(400);
  try {
    enforceRateLimit(actor, RATE_RULES.pdfUser);
    const prefs = getPreferences(actor.userId);
    const { design, accent, surface, text, line, logo } = query.data;
    const appearance: PreviewAppearance = {
      designId: design ?? prefs.designId,
      colors: {
        accent: accent ?? prefs.accentColor,
        surface: surface ?? prefs.surfaceColor,
        text: text ?? prefs.textColor,
        line: line ?? prefs.lineColor,
      },
      logoPosition: logo ?? prefs.logoPosition,
    };
    const data = await designPreviewPdf(actor.userId, appearance);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(data.length),
        "Content-Disposition": contentDisposition("inline", "nahled.pdf"),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return empty(429);
    throw error;
  }
}
