"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { preferencesSchema, savePreferences } from "@/server/services/preferences";

const designChoiceSchema = preferencesSchema.pick({
  designId: true,
  accentColor: true,
  surfaceColor: true,
  textColor: true,
  lineColor: true,
  logoPosition: true,
});

export type DesignChoiceInput = z.input<typeof designChoiceSchema>;

export async function saveDesignAction(raw: unknown) {
  await requireSession();
  const parsed = designChoiceSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? TEXTS.designs.invalid };
  }
  try {
    savePreferences(await actorFromRequest(), parsed.data);
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false as const, error: error.message };
    throw error;
  }
  revalidatePath("/nastaveni/designy");
  revalidatePath("/nastaveni/vychozi");
  return { ok: true as const };
}
