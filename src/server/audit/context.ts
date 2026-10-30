import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = {
  userId: string | null;
  source: "web" | "scheduler" | "import" | "system";
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
