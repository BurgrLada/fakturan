import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { McpLevel } from "@/lib/mcp-settings";
import { user } from "./auth";

const flag = (name: string) => integer(name, { mode: "boolean" });

// One row per user once they save Nastavení › Asistenti; without a row the defaults of
// getMcpSettings apply (MCP-010, MCP-015). Part of the account backup; a restore always switches
// access off again (MCP-042).
export const mcpSettings = sqliteTable("mcp_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  enabled: flag("enabled").notNull().default(false),
  level: text({ enum: ["read", "drafts", "accounting", "issue_send", "full"] })
    .$type<McpLevel>()
    .notNull()
    .default("read"),
  logCalls: flag("log_calls").notNull().default(true),
  revision: integer().notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type McpSettingsRow = typeof mcpSettings.$inferSelect;

// One line per assistant call while logging is on (MCP-060): who, which tool, how it ended. Never
// the arguments or the output. Not in the account backup (MCP-065); purged after 90 days (MCP-064).
export const mcpCallLog = sqliteTable(
  "mcp_call_log",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    at: integer({ mode: "timestamp_ms" }).notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    tool: text().notNull(),
    outcome: text({ enum: ["ok", "denied", "error"] }).notNull(),
    reason: text(),
    requiredLevel: text("required_level").$type<McpLevel>(),
    requestId: text("request_id").notNull(),
  },
  (table) => [index("mcp_call_log_owner_at").on(table.ownerId, table.at)],
);

export type McpCallLogRow = typeof mcpCallLog.$inferSelect;
