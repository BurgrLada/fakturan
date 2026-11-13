import "server-only";
import {
  DEFAULT_MCP_SETTINGS,
  mcpSettingsSchema,
  type McpLevel,
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

export type { McpLevel, McpSettings };

const E = TEXTS.mcp.settings.errors;

function ownerOf(actor: Actor): string {
  if (!actor.userId) throw new ServiceError(E.forbidden);
  return actor.userId;
}

function readSettings(tx: Pick<Tx, "select">, ownerId: string): McpSettings {
  const row = tx.select().from(mcpSettings).where(scoped(ownerId).where(mcpSettings)).get();
  if (!row) return { ...DEFAULT_MCP_SETTINGS };
  const { enabled, level, logCalls, revision } = row;
  return { enabled, level, logCalls, revision };
}

// Read on every authorization and every tool call (MCP-006, MCP-012): a local SQLite read.
export function getMcpSettings(ownerId: string): McpSettings {
  return readSettings(db, ownerId);
}

// The level the assistant has right now; null when access is off (MCP-050).
export function activeLevel(settings: McpSettings): McpLevel | null {
  return settings.enabled ? settings.level : null;
}

export function saveMcpSettings(actor: Actor, raw: unknown): McpSettings {
  const ownerId = ownerOf(actor);
  const parsed = mcpSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(E.invalid);
  const input = parsed.data;
  return mutate(actor, "mcp.settings_changed", (tx, audit) => {
    const before = readSettings(tx, ownerId);
    if (before.revision !== input.revision) throw new ServiceError(E.stale);
    const values = {
      enabled: input.enabled,
      level: input.level,
      logCalls: input.logCalls,
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
