import "server-only";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../db";
import { oauthConsent } from "../db/schema";

const TOUCH_INTERVAL_MS = 60_000;

// „Naposledy použit“ to the minute is enough (MCP-013), so a busy assistant writes at most once a
// minute per connection. Not account data and not a change the user made: outside the audit
// (MCP-041). One conditional UPDATE, so concurrent calls cannot write twice.
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
