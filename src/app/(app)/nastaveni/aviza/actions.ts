"use server";

import { revalidatePath } from "next/cache";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { clearBankMailbox, saveBankMailbox, testBankMailbox } from "@/server/services/bank-mailbox";

type Outcome = { ok: true } | { ok: false; error: string };
type ActorOf = Awaited<ReturnType<typeof actorFromRequest>>;

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded(work: (actor: ActorOf) => void | Promise<void>): Promise<Outcome> {
  try {
    await work(await actorFromRequest());
    revalidatePath("/nastaveni/aviza");
    return { ok: true };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function saveBankMailboxAction(raw: unknown): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => saveBankMailbox(actor, raw));
}

export async function clearBankMailboxAction(): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => clearBankMailbox(actor));
}

export async function testBankMailboxAction(): Promise<Outcome> {
  await requireSession();
  return guarded((actor) => testBankMailbox(actor));
}
