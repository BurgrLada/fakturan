import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = {
  userId: string | null;
  source: "web" | "scheduler" | "import" | "system" | "mcp";
  // With source "mcp": the OAuth client acting for the user and its self-declared name (MCP-030).
  clientId?: string;
  clientName?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
};

const storage = new AsyncLocalStorage<Actor>();

export function runWithActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

export function currentActor(): Actor {
  const actor = storage.getStore();
  if (!actor) throw new Error("Auditní záznam nemá aktéra: zápis musí běžet uvnitř mutate");
  return actor;
}
