"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LANGUAGES } from "@/lib/preferences";
import { MESSAGE_KINDS } from "@/lib/email-template";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { resetEmailTemplate, saveEmailTemplate } from "@/server/services/email-templates";

type Outcome = { ok: true } | { ok: false; error: string };
type ActorOf = Awaited<ReturnType<typeof actorFromRequest>>;

const resetSchema = z.object({ kind: z.enum(MESSAGE_KINDS), language: z.enum(LANGUAGES) });

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded(work: (actor: ActorOf) => void): Promise<Outcome> {
  try {
    work(await actorFromRequest());
    revalidatePath("/nastaveni/posta/sablony");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveEmailTemplateAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => saveEmailTemplate(actor, raw));
}

export async function resetEmailTemplateAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  const parsed = resetSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TEXTS.emailTemplates.errors.invalid };
  return guarded((actor) => resetEmailTemplate(actor, parsed.data.kind, parsed.data.language));
}
