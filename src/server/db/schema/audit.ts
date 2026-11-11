import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Rows are protected by triggers in drizzle/0001_audit_triggers.sql. owner_id deliberately has no
// foreign key: a cascade must never reach this table.
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: integer({ mode: "timestamp_ms" }).notNull(),
    actorId: text("actor_id"),
    ownerId: text("owner_id"),
    source: text({ enum: ["web", "scheduler", "import", "system", "mcp"] }).notNull(),
    scope: text({ enum: ["user", "instance"] }).notNull(),
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text("entity_id"),
    before: text({ mode: "json" }),
    after: text({ mode: "json" }),
    ip: text(),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    // The assistant behind a change made through MCP (MCP-030); the name is the client's own claim.
    clientId: text("client_id"),
    clientName: text("client_name"),
  },
  (t) => [
    index("audit_log_owner_at_idx").on(t.ownerId, t.at),
    // accountStamp reads max(id) per account on every report request (ARC-005).
    index("audit_log_owner_id_idx").on(t.ownerId, t.id),
    index("audit_log_entity_idx").on(t.entity, t.entityId),
  ],
);

// A row here temporarily permits deleting that account's user-scoped audit rows (AUD-010).
export const auditPurge = sqliteTable("audit_purge", {
  ownerId: text("owner_id").primaryKey(),
});
