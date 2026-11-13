import "server-only";
import type { Actor } from "../audit/context";
import { checkRateLimit, RATE_RULES } from "../rate-limit";
import { mcpClientName } from "../services/mcp-connections";
import { mutate } from "../services/mutation";

const RULE = RATE_RULES.mcpCallUserClient;

// 60 requests a minute per user and client (MCP-032), counted at the HTTP layer so an exceeded
// limit can answer 429 with Retry-After. One busy assistant cannot starve another of the same
// user. The first refusal of a window is audited like any other limit. Returns the seconds to wait,
// or null when the request may pass.
export function mcpRateLimit(ownerId: string, clientId: string): number | null {
  const result = checkRateLimit(`${ownerId}:${clientId}`, RULE);
  if (result.allowed) return null;
  if (result.firstDenial) {
    const actor: Actor = {
      userId: ownerId,
      source: "mcp",
      clientId,
      clientName: mcpClientName(clientId),
    };
    mutate(actor, "rate_limit.exceeded", (_tx, audit) =>
      audit({
        entity: "rate_limit",
        entityId: null,
        ownerId,
        scope: "instance",
        after: { rule: RULE.name, retryAfterSeconds: result.retryAfterSeconds },
      }),
    );
  }
  return result.retryAfterSeconds;
}
