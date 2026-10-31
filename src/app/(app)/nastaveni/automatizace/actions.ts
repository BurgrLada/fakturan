"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AUTOMATION_KEYS } from "@/lib/automation";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  setAutomation,
  setDailyDigest,
  setPaused,
  setSendTime,
} from "@/server/services/automation";
import { deleteReminderRule, saveReminderRule } from "@/server/services/reminders";

type Outcome = { ok: true } | { ok: false; error: string };
type ActorOf = Awaited<ReturnType<typeof actorFromRequest>>;

const toggle = z.object({
  key: z.enum(AUTOMATION_KEYS),
  enabled: z.boolean(),
  confirmed: z.boolean(),
});

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded(work: (actor: ActorOf) => void): Promise<Outcome> {
  try {
    work(await actorFromRequest());
    revalidatePath("/nastaveni/automatizace");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function setAutomationAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  const parsed = toggle.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Neplatný požadavek" };
  const { key, enabled, confirmed } = parsed.data;
  return guarded((actor) => setAutomation(actor, key, enabled, { confirmed }));
}

export async function setPausedAction(paused: boolean, confirmed: boolean): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => setPaused(actor, paused === true, { confirmed: confirmed === true }));
}

export async function setSendTimeAction(value: string): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => setSendTime(actor, String(value)));
}

export async function setDailyDigestAction(enabled: boolean): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => setDailyDigest(actor, enabled === true));
}

export async function saveReminderRuleAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => {
    saveReminderRule(actor, raw);
  });
}

export async function deleteReminderRuleAction(id: string): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => deleteReminderRule(actor, String(id)));
}
