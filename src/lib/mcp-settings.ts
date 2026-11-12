import { z } from "zod";

// One permission level per user, each adding to the one before it (MCP-050).
export type McpLevel = "read" | "drafts" | "accounting" | "issue_send" | "full";

export const MCP_LEVELS: readonly McpLevel[] = [
  "read",
  "drafts",
  "accounting",
  "issue_send",
  "full",
];

export function levelAtLeast(have: McpLevel, need: McpLevel): boolean {
  return MCP_LEVELS.indexOf(have) >= MCP_LEVELS.indexOf(need);
}

export type McpSettings = {
  enabled: boolean;
  level: McpLevel;
  logCalls: boolean;
  revision: number;
};

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  level: "read",
  logCalls: true,
  revision: 0,
};

export const mcpSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  level: z.enum(MCP_LEVELS as [McpLevel, ...McpLevel[]]),
  logCalls: z.boolean(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type McpSettingsInput = z.input<typeof mcpSettingsSchema>;
