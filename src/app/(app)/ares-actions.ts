"use server";

import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import type { AresResult } from "@/server/external/ares";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { lookupCompany } from "@/server/services/company-lookup";

type Failure = { ok: false; error: string };

const icoInput = z.object({ ico: z.string().trim().max(20) });

export async function lookupAresAction(
  raw: unknown,
): Promise<{ ok: true; result: AresResult | null } | Failure> {
  await requireSession();
  const parsed = icoInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: TEXTS.supplier.validation.invalid };
  try {
    return { ok: true, result: await lookupCompany(await actorFromRequest(), parsed.data.ico) };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}
