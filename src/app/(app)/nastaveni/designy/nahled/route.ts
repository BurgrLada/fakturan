import { z } from "zod";
import { RATE_RULES } from "@/server/rate-limit";
import { designPreviewPdf, type PreviewAppearance } from "@/server/services/design-preview";
import { InvalidPreviewQuery, servePdf } from "@/server/services/pdf-http";
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

export async function GET(request: Request) {
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  return servePdf("inline", RATE_RULES.pdfPreviewUser, async (_actor, userId) => {
    if (!query.success) throw new InvalidPreviewQuery();
    const prefs = getPreferences(userId);
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
    return { data: await designPreviewPdf(userId, appearance), fileName: "nahled.pdf" };
  });
}
