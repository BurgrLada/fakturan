import "server-only";
import { clock } from "../clock";
import type { Tx } from "../db";
import { auditLog } from "../db/schema";
import { currentActor } from "./context";
import { redact } from "./redact";

export type AuditAction = `${string}.${string}`;

export type AuditEntry = {
  action: AuditAction;
  entity: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  ownerId: string | null;
  scope: "user" | "instance";
};

// listInstanceAudit shows entity and id to the admin, so naming account data here would leak it
// (ADM-007). Later plans add their own instance entities here.
const INSTANCE_ENTITIES = new Set([
  "user",
  "session",
  "account",
  "invitation",
  "rate_limit",
  "route",
]);

function assertValidScope({ scope, ownerId, entity, action }: AuditEntry): void {
  // audit_purge matches by owner, so an ownerless user row could never be deleted (AUD-010).
  if (scope === "user" && !ownerId) {
    throw new Error(`Auditní záznam ${action} je bez vlastníka`);
  }
  if (scope === "instance" && !INSTANCE_ENTITIES.has(entity)) {
    throw new Error(`Entita ${entity} nepatří do auditu instance`);
  }
}

export function recordAudit(tx: Tx, entry: AuditEntry): void {
  assertValidScope(entry);
  const actor = currentActor();
  tx.insert(auditLog)
    .values({
      at: clock.now(),
      actorId: actor.userId,
      ownerId: entry.ownerId,
      source: actor.source,
      scope: entry.scope,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: redact(entry.before),
      after: redact(entry.after),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    })
    .run();
}
