"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { accountTag } from "@/server/account-cache";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { deleteOwnAccount } from "@/server/services/users";

const input = z.object({ password: z.string().max(1024).optional() });

export async function deleteOwnAccountAction(raw: unknown): Promise<{ error: string }> {
  const { session } = await requireSession();
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { error: "Neplatné údaje" };
  try {
    await deleteOwnAccount(await actorFromRequest(), session, parsed.data.password);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
  redirect("/prihlaseni");
}

export async function refreshAccountData(): Promise<void> {
  const { user } = await requireSession();
  updateTag(accountTag(user.id));
}
