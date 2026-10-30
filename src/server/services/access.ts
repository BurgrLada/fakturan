import "server-only";
import { eq } from "drizzle-orm";
import type { Actor } from "../audit/context";
import type { Db, Tx } from "../db";
import { user } from "../db/schema";
import { checkRateLimit, type RateRule } from "../rate-limit";
import { mutate } from "./mutation";

export type Reader = Pick<Db | Tx, "select">;

// The message is shown to the user as is.
export class ServiceError extends Error {}

export function assertAdmin(q: Reader, actor: Actor): void {
  const row = actor.userId
    ? q
        .select({ role: user.role, banned: user.banned })
        .from(user)
        .where(eq(user.id, actor.userId))
        .get()
    : undefined;
  if (row?.role !== "admin" || row.banned) throw new ServiceError("Na tuto akci nemáte oprávnění");
}

export function enforceRateLimit(actor: Actor, rule: RateRule): void {
  const result = checkRateLimit(actor.userId ?? "system", rule);
  if (result.allowed) return;
  if (result.firstDenial) {
    mutate(actor, "rate_limit.exceeded", (_tx, audit) =>
      audit({
        entity: "rate_limit",
        entityId: null,
        ownerId: actor.userId,
        scope: "instance",
        after: { rule: rule.name, retryAfterSeconds: result.retryAfterSeconds },
      }),
    );
  }
  throw new ServiceError("Příliš mnoho pokusů, zkuste to později");
}
