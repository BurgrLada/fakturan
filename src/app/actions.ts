"use server";

import { z } from "zod";
import { THEME_CHOICES } from "@/lib/theme";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { setTheme } from "@/server/services/settings";

const input = z.object({ theme: z.enum(THEME_CHOICES) });

export async function setThemeAction(raw: unknown): Promise<{ ok: boolean }> {
  await requireSession();
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false };
  try {
    setTheme(await actorFromRequest(), parsed.data.theme);
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false };
    throw error;
  }
  return { ok: true };
}
