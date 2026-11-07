"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { clearMailLogo, saveMailLook, setMailLogo } from "@/server/services/mail-look";

type Outcome = { ok: true } | { ok: false; error: string };

const uploadInput = z.object({ file: z.instanceof(File) });

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded(work: (actor: Awaited<ReturnType<typeof actorFromRequest>>) => unknown) {
  await requireSession();
  try {
    await work(await actorFromRequest());
    revalidatePath("/nastaveni/posta/vzhled");
    return { ok: true } as Outcome;
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message } as Outcome;
    throw error;
  }
}

export async function saveMailLookAction(raw: unknown): Promise<Outcome> {
  return guarded((actor) => saveMailLook(actor, raw));
}

export async function uploadMailLogoAction(formData: FormData): Promise<Outcome> {
  const parsed = uploadInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    await requireSession();
    return { ok: false, error: TEXTS.mailLook.errors.invalid };
  }
  const { file } = parsed.data;
  return guarded(async (actor) =>
    setMailLogo(actor, Buffer.from(await file.arrayBuffer()), file.name),
  );
}

export async function removeMailLogoAction(): Promise<Outcome> {
  return guarded((actor) => clearMailLogo(actor));
}
