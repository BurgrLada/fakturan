import "server-only";
import { desc } from "drizzle-orm";
import { db } from "../db";
import { auditLog } from "../db/schema";
import { scoped } from "../db/scoped";

export function listAuditForOwner(ownerId: string, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(scoped(ownerId).where(auditLog))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit)
    .all();
}
