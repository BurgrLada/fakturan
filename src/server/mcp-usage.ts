import "server-only";
import * as Sentry from "@sentry/nextjs";
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { McpLevel } from "@/lib/mcp-settings";
import { db } from "./db";
import { mcpCallLog, oauthConsent } from "./db/schema";
import { logger } from "./logger";
import type { McpCallOutcome, McpCallReason } from "./services/mcp-call-log";
import { getMcpSettings } from "./services/mcp-settings";

// What an assistant's calls leave behind: the call log and „Naposledy použit“. Operational records,
// not changes the user made, so they live outside services and leave no audit trail (MCP-041,
// MCP-061).

export const MCP_CALL_LOG_DAYS = 90;
const DAY_MS = 86_400_000;
const TOUCH_INTERVAL_MS = 60_000;

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

// Lines older than 90 days go (MCP-064).
export function purgeMcpCallLog(now: Date): void {
  const cutoff = new Date(now.getTime() - MCP_CALL_LOG_DAYS * DAY_MS);
  db.delete(mcpCallLog).where(lt(mcpCallLog.at, cutoff)).run();
}

// „Naposledy použit“ to the minute is enough (MCP-013), so a busy assistant writes at most once a
// minute per connection. One conditional UPDATE, so concurrent calls cannot write twice.
export function touchMcpConnection(ownerId: string, clientId: string, now: Date): void {
  const due = new Date(now.getTime() - TOUCH_INTERVAL_MS);
  db.update(oauthConsent)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(oauthConsent.userId, ownerId),
        eq(oauthConsent.clientId, clientId),
        or(isNull(oauthConsent.lastUsedAt), lte(oauthConsent.lastUsedAt, due)),
      ),
    )
    .run();
}
