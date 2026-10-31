"use server";

import { revalidatePath } from "next/cache";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { clearOwnSmtp, saveMailSettings, sendTestMail } from "@/server/services/mail-settings";

type Outcome = { ok: true } | { ok: false; error: string };
type ActorOf = Awaited<ReturnType<typeof actorFromRequest>>;

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded(work: (actor: ActorOf) => void | Promise<void>): Promise<Outcome> {
  try {
    await work(await actorFromRequest());
    revalidatePath("/nastaveni/posta");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveMailSettingsAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => saveMailSettings(actor, raw));
}

export async function clearOwnSmtpAction(): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => clearOwnSmtp(actor));
}

export async function sendTestMailAction(): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => sendTestMail(actor));
}
