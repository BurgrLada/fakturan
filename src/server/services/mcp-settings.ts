import "server-only";
import {
  AVAILABLE_CAPABILITIES,
  DEFAULT_MCP_SETTINGS,
  MCP_CAPABILITIES,
  mcpSettingsSchema,
  type McpCapability,
  type McpSettings,
} from "@/lib/mcp-settings";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db, type Tx } from "../db";
import { mcpSettings } from "../db/schema";
import { scoped } from "../db/scoped";
import { ServiceError } from "./access";
import { mutate } from "./mutation";

export { AVAILABLE_CAPABILITIES, type McpCapability, type McpSettings };

const E = TEXTS.mcp.settings.errors;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

function readSettings(tx: Pick<Tx, "select">, ownerId: string): McpSettings {
  const row = tx.select().from(mcpSettings).where(scoped(ownerId).where(mcpSettings)).get();
  if (!row) return { ...DEFAULT_MCP_SETTINGS };
  const { enabled, read, create, edit, issue, send, revision } = row;
  return { enabled, read, create, edit, issue, send, revision };
}

// Read on every authorization and every tool call (MCP-006, MCP-012): a local SQLite read.
export function getMcpSettings(ownerId: string): McpSettings {
  return readSettings(db, ownerId);
}

// The capabilities the assistant may use right now; empty when access is off.
export function allowedCapabilities(settings: McpSettings): McpCapability[] {
  if (!settings.enabled) return [];
  return AVAILABLE_CAPABILITIES.filter((capability) => settings[capability]);
}

export function saveMcpSettings(actor: Actor, raw: unknown): McpSettings {
  const ownerId = ownerOf(actor);
  const parsed = mcpSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(E.invalid);
  const input = parsed.data;
  // The switches without a tool behind them stay off until they ship (MCP-011).
  const unavailable = MCP_CAPABILITIES.filter((c) => !AVAILABLE_CAPABILITIES.includes(c));
  if (unavailable.some((capability) => input[capability])) {
    throw new ServiceError(E.notAvailable);
  }
  return mutate(actor, "mcp.settings_changed", (tx, audit) => {
    const before = readSettings(tx, ownerId);
    if (before.revision !== input.revision) throw new ServiceError(E.stale);
    const values = {
      enabled: input.enabled,
      read: input.read,
      create: input.create,
      edit: false,
      issue: false,
      send: false,
      revision: before.revision + 1,
      updatedAt: clock.now(),
    };
    tx.insert(mcpSettings)
      .values({ userId: ownerId, ...values })
      .onConflictDoUpdate({ target: mcpSettings.userId, set: values })
      .run();
    const after = readSettings(tx, ownerId);
    const { revision: _before, ...was } = before;
    const { revision: _after, ...now } = after;
    audit({
      entity: "mcp_settings",
      entityId: ownerId,
      ownerId,
      scope: "user",
      before: was,
      after: now,
    });
    return after;
  });
}
