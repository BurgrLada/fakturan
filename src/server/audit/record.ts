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

export function recordAudit(tx: Tx, entry: AuditEntry): void {
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
