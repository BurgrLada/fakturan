import "server-only";
import { desc, eq } from "drizzle-orm";
import type { Actor } from "../audit/context";
import { db } from "../db";
import { auditLog, user } from "../db/schema";
import { assertAdmin } from "./access";

// Changes, IP and user agent stay out: an admin sees that something happened, not its content (ADM-007).
export function listInstanceAudit(actor: Actor, limit = 100) {
  assertAdmin(db, actor);
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      source: auditLog.source,
      actorEmail: user.email,
    })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorId))
    .where(eq(auditLog.scope, "instance"))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit)
    .all();
}
