"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/server/auth";
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

type Outcome = { ok: true } | { ok: false; error: string };

// The session token never reaches the browser: sessions are addressed by id and resolved here.
export async function revokeSessionAction(raw: unknown): Promise<Outcome> {
  const parsed = z.object({ id: z.string().min(1).max(128) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Neplatné údaje" };
  const { session } = await requireSession();
  if (parsed.data.id === session.id) {
    return { ok: false, error: "Aktuální relaci ukončíte odhlášením" };
  }
  const requestHeaders = await headers();
  const target = (await auth.api.listSessions({ headers: requestHeaders })).find(
    (row) => row.id === parsed.data.id,
  );
  if (!target) return { ok: false, error: "Relace už neexistuje" };
  await auth.api.revokeSession({ headers: requestHeaders, body: { token: target.token } });
  return { ok: true };
}

export async function revokeOtherSessionsAction(): Promise<Outcome> {
  await requireSession();
  await auth.api.revokeOtherSessions({ headers: await headers() });
  return { ok: true };
}
