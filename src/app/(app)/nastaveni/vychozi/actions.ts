"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  completeOnboarding,
  preferencesPatchSchema,
  savePreferences,
} from "@/server/services/preferences";

type Failure = { ok: false; error: string };

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function run<Input>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (input: Input, actor: Awaited<ReturnType<typeof actorFromRequest>>) => void,
): Promise<{ ok: true } | Failure> {
  await requireSession();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? TEXTS.preferences.validation.invalid,
    };
  }
  try {
    work(parsed.data, await actorFromRequest());
    revalidatePath("/nastaveni/vychozi");
    revalidatePath("/pruvodce");
    revalidatePath("/");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function savePreferencesAction(raw: unknown) {
  return run(preferencesPatchSchema, raw, (input, actor) => {
    savePreferences(actor, input);
  });
}

export async function completeOnboardingAction() {
  return run(preferencesPatchSchema, {}, (_input, actor) => {
    completeOnboarding(actor);
  });
}
