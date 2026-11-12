import "server-only";
import * as Sentry from "@sentry/nextjs";
import { and, desc, eq, lt } from "drizzle-orm";
import type { McpLevel } from "@/lib/mcp-settings";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { db } from "../db";
import { mcpCallLog, type McpCallLogRow } from "../db/schema";
import { scoped } from "../db/scoped";
import { logger } from "../logger";
import { ServiceError } from "./access";
import type { Page } from "./audit-read";
import { getMcpSettings } from "./mcp-settings";
import { mutate } from "./mutation";

export type McpCallOutcome = "ok" | "denied" | "error";
export type McpCallReason =
  | "level"
  | "disabled"
  | "not_connected"
  | "unavailable"
  | "invalid_input"
  | "service_error"
  | "confirm_in_web";
export type McpCallRow = McpCallLogRow;

export const MCP_CALL_LOG_DAYS = 90;
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

export type McpCallEntry = {
  ownerId: string;
  clientId: string;
  clientName: string;
  tool: string;
  outcome: McpCallOutcome;
  reason: McpCallReason | null;
  requiredLevel: McpLevel | null;
  requestId: string;
  at: Date;
};

// One line per call while the switch is on (MCP-062), never the arguments or the output (MCP-060).
// Outside the service's transaction, and a failure here never changes the call's result (MCP-061).
export function recordMcpCall(entry: McpCallEntry): void {
  try {
    if (!getMcpSettings(entry.ownerId).logCalls) return;
    db.insert(mcpCallLog).values(entry).run();
  } catch (error) {
    logger.error("zápis logu volání asistenta selhal", { tool: entry.tool });
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error, {
        tags: { "mcp.tool": entry.tool },
        user: { id: entry.ownerId },
      });
    }
  }
}

// Newest first, 50 per page, filtered by assistant and outcome (MCP-063).
export function listMcpCalls(
  ownerId: string,
  filter: { clientId?: string; outcome?: McpCallOutcome; page: number },
): Page<McpCallRow> {
  const page = Math.max(1, Math.floor(filter.page));
  const rows = db
    .select()
    .from(mcpCallLog)
    .where(
      scoped(ownerId).where(mcpCallLog, (t) =>
        and(
          filter.clientId ? eq(t.clientId, filter.clientId) : undefined,
          filter.outcome ? eq(t.outcome, filter.outcome) : undefined,
        ),
      ),
    )
    .orderBy(desc(mcpCallLog.at), desc(mcpCallLog.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
    .all();
  return {
    rows: rows.slice(0, PAGE_SIZE),
    page,
    pageSize: PAGE_SIZE,
    hasNext: rows.length > PAGE_SIZE,
  };
}

// The assistants the log names, for the filter.
export function listMcpCallClients(ownerId: string): { clientId: string; clientName: string }[] {
  return db
    .selectDistinct({ clientId: mcpCallLog.clientId, clientName: mcpCallLog.clientName })
    .from(mcpCallLog)
    .where(scoped(ownerId).where(mcpCallLog))
    .orderBy(mcpCallLog.clientName)
    .all();
}

// „Smazat log“ in the web (MCP-064); the clearing itself goes to the history.
export function clearMcpCallLog(actor: Actor): void {
  const ownerId = actor.userId;
  if (!ownerId) throw new ServiceError(TEXTS.mcp.callLog.errors.forbidden);
  mutate(actor, "mcp.call_log_cleared", (tx, audit) => {
    const { changes } = tx.delete(mcpCallLog).where(scoped(ownerId).where(mcpCallLog)).run();
    audit({
      entity: "mcp_call_log",
      entityId: ownerId,
      ownerId,
      scope: "user",
      before: { rows: changes },
      after: { rows: 0 },
    });
  });
}

// Lines older than 90 days go (MCP-064): an operational record, not history.
export function purgeMcpCallLog(now: Date): void {
  const cutoff = new Date(now.getTime() - MCP_CALL_LOG_DAYS * DAY_MS);
  db.delete(mcpCallLog).where(lt(mcpCallLog.at, cutoff)).run();
}
