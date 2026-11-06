"use server";

import { revalidatePath } from "next/cache";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { createBackup, listBackups } from "@/server/services/account-backup";
import { latestRestore, type BackupListRow } from "@/server/services/exports";

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded<T extends object>(
  work: () => T | Promise<T>,
  revalidate = true,
): Promise<Outcome<T>> {
  try {
    const result = await work();
    if (revalidate) revalidatePath("/nastaveni/zaloha");
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

// Takes no input: the account is the session's, never something the client names.
export async function createBackupAction(): Promise<Outcome<{ id: string }>> {
  await requireSession();
  return guarded(async () => createBackup(await actorFromRequest()));
}

// Polled while a backup runs, so it neither revalidates nor reads anything but the list.
export async function backupListAction(): Promise<Outcome<{ rows: BackupListRow[] }>> {
  const { user } = await requireSession();
  return guarded(() => ({ rows: listBackups(user.id) }), false);
}

// Polled while a restore runs; the upload itself goes through the nahrani route.
export async function restoreStateAction(): Promise<Outcome<{ restore: BackupListRow | null }>> {
  const { user } = await requireSession();
  return guarded(() => ({ restore: latestRestore(user.id) }), false);
}
