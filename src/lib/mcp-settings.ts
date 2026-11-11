import { z } from "zod";

export type McpCapability = "read" | "create" | "edit" | "issue" | "send";

export const MCP_CAPABILITIES: readonly McpCapability[] = [
  "read",
  "create",
  "edit",
  "issue",
  "send",
];

// What the first version can do; the other switches are shown as „připravujeme“ (MCP-011).
export const AVAILABLE_CAPABILITIES: readonly McpCapability[] = ["read", "create"];

export type McpSettings = {
  enabled: boolean;
  read: boolean;
  create: boolean;
  edit: boolean;
  issue: boolean;
  send: boolean;
  revision: number;
};

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  read: true,
  create: false,
  edit: false,
  issue: false,
  send: false,
  revision: 0,
};

// The capabilities not yet available may be sent as false or left out, never switched on.
export const mcpSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  read: z.boolean(),
  create: z.boolean(),
  edit: z.boolean().default(false),
  issue: z.boolean().default(false),
  send: z.boolean().default(false),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type McpSettingsInput = z.input<typeof mcpSettingsSchema>;
