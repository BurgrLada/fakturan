"use server";

import { revalidatePath } from "next/cache";
import type { ExportInput } from "@/lib/export-filter";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { createExport, listExports, type ExportListRow } from "@/server/services/exports";

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded<T extends object>(
  work: () => T | Promise<T>,
  revalidate = true,
): Promise<Outcome<T>> {
  try {
    const result = await work();
    if (revalidate) revalidatePath("/nastaveni/export");
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

// The service validates the input with the shared strict schema.
export async function createExportAction(raw: unknown): Promise<Outcome<{ id: string }>> {
  await requireSession();
  return guarded(async () => createExport(await actorFromRequest(), raw as ExportInput));
}

// Polled while an export runs, so it neither revalidates nor reads anything but the list.
export async function exportListAction(): Promise<Outcome<{ rows: ExportListRow[] }>> {
  const { user } = await requireSession();
  return guarded(() => ({ rows: listExports(user.id) }), false);
}
