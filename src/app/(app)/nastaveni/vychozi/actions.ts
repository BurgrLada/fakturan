"use server";

import { revalidatePath } from "next/cache";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { ensureDefaultSeries } from "@/server/services/number-series";
import {
  completeOnboarding,
  preferencesPatchSchema,
  savePreferences,
} from "@/server/services/preferences";

type Failure = { ok: false; error: string };

type ActorOf = Awaited<ReturnType<typeof actorFromRequest>>;

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded(work: (actor: ActorOf) => void): Promise<{ ok: true } | Failure> {
  try {
    work(await actorFromRequest());
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
  await requireSession();
  const parsed = preferencesPatchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? TEXTS.preferences.validation.invalid,
    };
  }
  return guarded((actor) => savePreferences(actor, parsed.data));
}

export async function ensureSeriesAction() {
  await requireSession();
  return guarded((actor) => ensureDefaultSeries(actor));
}

export async function completeOnboardingAction() {
  await requireSession();
  return guarded((actor) => {
    ensureDefaultSeries(actor);
    completeOnboarding(actor);
  });
}
