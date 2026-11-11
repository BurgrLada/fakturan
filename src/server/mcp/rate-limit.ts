import "server-only";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { checkRateLimit, RATE_RULES } from "../rate-limit";
import { mutate } from "../services/mutation";
import { McpToolError } from "./errors";

const RULE = RATE_RULES.mcpCallUserClient;

// 60 tool calls a minute per user and client (MCP-032). One busy assistant cannot starve another
// of the same user. The first refusal of a window is audited like any other limit.
export function enforceMcpRateLimit(actor: Actor & { userId: string; clientId: string }): void {
  const result = checkRateLimit(`${actor.userId}:${actor.clientId}`, RULE);
  if (result.allowed) return;
  if (result.firstDenial) {
    mutate(actor, "rate_limit.exceeded", (_tx, audit) =>
      audit({
        entity: "rate_limit",
        entityId: null,
        ownerId: actor.userId,
        scope: "instance",
        after: { rule: RULE.name, retryAfterSeconds: result.retryAfterSeconds },
      }),
    );
  }
  throw new McpToolError(TEXTS.mcp.tools.rateLimited(result.retryAfterSeconds));
}
