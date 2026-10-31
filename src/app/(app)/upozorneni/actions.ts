"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { markAllRead, markRead } from "@/server/services/notifications";

const id = z.string().min(1).max(64);

export async function markReadAction(raw: unknown): Promise<void> {
  await requireSession();
  const parsed = id.safeParse(raw);
  if (!parsed.success) return;
  markRead(await actorFromRequest(), parsed.data);
  revalidatePath("/", "layout");
}

export async function markAllReadAction(): Promise<void> {
  await requireSession();
  markAllRead(await actorFromRequest());
  revalidatePath("/", "layout");
}
