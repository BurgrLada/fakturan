"use server";

import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { type McpSettings } from "@/lib/mcp-settings";
import { actorFromRequest, requireSession } from "@/server/auth/session";
import { env } from "@/server/env";
import { isMcpAvailable } from "@/server/mcp/availability";
import { ServiceError } from "@/server/services/access";
import { disconnectMcpClient } from "@/server/services/mcp-connections";
import { saveMcpSettings } from "@/server/services/mcp-settings";

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// Only known refusals become messages: requireSession's redirect must keep propagating.
async function guarded<T>(work: (actor: Awaited<ReturnType<typeof actorFromRequest>>) => T) {
  if (!isMcpAvailable(env)) notFound();
  try {
    const value = work(await actorFromRequest());
    revalidatePath("/nastaveni/asistenti");
    return { ok: true as const, value };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false as const, error: error.message };
    throw error;
  }
}

export async function saveMcpSettingsAction(
  raw: unknown,
): Promise<Outcome<{ settings: McpSettings }>> {
  await requireSession();
  const result = await guarded((actor) => saveMcpSettings(actor, raw));
  return result.ok ? { ok: true, settings: result.value } : result;
}

export async function disconnectMcpClientAction(clientId: string): Promise<Outcome> {
  await requireSession();
  const result = await guarded((actor) => disconnectMcpClient(actor, String(clientId)));
  return result.ok ? { ok: true } : result;
}
