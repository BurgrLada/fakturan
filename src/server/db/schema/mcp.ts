import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  read: flag("can_read").notNull().default(true),
  create: flag("can_create").notNull().default(false),
  edit: flag("can_edit").notNull().default(false),
  issue: flag("can_issue").notNull().default(false),
  send: flag("can_send").notNull().default(false),
  revision: integer().notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type McpSettingsRow = typeof mcpSettings.$inferSelect;
