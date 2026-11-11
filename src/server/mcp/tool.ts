import "server-only";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { McpCapability } from "@/lib/mcp-settings";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { czechError } from "@/lib/validation-issue";
import { runWithActor, type Actor } from "../audit/context";
import { clock } from "../clock";
import type { Env } from "../env";
import {
  isMcpAccountActive,
  isMcpConnected,
  mcpClientName,
  touchMcpConnection,
} from "../services/mcp-connections";
import { allowedCapabilities, getMcpSettings } from "../services/mcp-settings";
import { isMcpAvailable } from "./availability";
import { McpToolError, toolErrorResult } from "./errors";
import { enforceMcpRateLimit } from "./rate-limit";

const T = TEXTS.mcp.tools;

// What a tool knows about the call: whose data, who acts (for the audit), and the instance.
export type ToolContext = {
  ownerId: string;
  actor: Actor;
  clientId: string;
  clientName: string;
  // The instance's origin, for absolute links into the web app.
  baseUrl: string;
  today: CalendarDate;
};

// A tool is a Zod input, a Zod output, the capability it needs and a call into a service (ARC-001).
export type ToolDef<I, O> = {
  name: string;
  title: string;
  description: string;
  capability: McpCapability;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run: (ctx: ToolContext, input: I) => O | Promise<O>;
  // The text for the model; values from documents must stay visibly data (MCP-033).
  text: (output: O) => string;
};

// The verified access token claims the wrapper needs: the user and the OAuth client.
export type McpClaims = { sub?: string; azp?: string; client_id?: string };

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

// Every tool the endpoint serves; each has its own input and output types. Tool modules add
// themselves here.
export const TOOLS: ToolDef<any, any>[] = [];

// The checks of MCP-012, in this order, on every call: nothing is trusted from the connection time.
function admit(def: ToolDef<unknown, unknown>, claims: McpClaims, env: Env): ToolContext {
  if (!isMcpAvailable(env)) throw new McpToolError(T.unavailable);
  const ownerId = claims.sub;
  if (!ownerId || !isMcpAccountActive(ownerId)) throw new McpToolError(T.noAccount);
  const settings = getMcpSettings(ownerId);
  if (!settings.enabled) throw new McpToolError(T.disabled);
  const clientId = claims.azp ?? claims.client_id;
  // JWT access tokens are not stored, so disconnecting cannot revoke them: the consent row decides.
  if (!clientId || !isMcpConnected(ownerId, clientId)) throw new McpToolError(T.notConnected);
  if (!allowedCapabilities(settings).includes(def.capability)) {
    throw new McpToolError(T.capabilityOff[def.capability]);
  }
  const clientName = mcpClientName(clientId);
  const actor = {
    userId: ownerId,
    source: "mcp",
    clientId,
    clientName,
    requestId: randomUUID(),
  } satisfies Actor;
  enforceMcpRateLimit(actor);
  return {
    ownerId,
    actor,
    clientId,
    clientName,
    baseUrl: new URL(env.BETTER_AUTH_URL).origin,
    today: calendarDateInPrague(clock.now()),
  };
}

export async function runTool<I, O>(
  def: ToolDef<I, O>,
  claims: McpClaims,
  raw: unknown,
  env: Env,
): Promise<CallToolResult> {
  try {
    const ctx = admit(def as ToolDef<unknown, unknown>, claims, env);
    const input = def.input.parse(raw, { error: czechError });
    const result = await runWithActor(ctx.actor, () => def.run(ctx, input));
    // A mismatch is our bug, not the user's input: it goes to Sentry as a general failure.
    const checked = def.output.safeParse(result);
    if (!checked.success) throw new Error(`Výstup nástroje ${def.name} neodpovídá schématu`);
    const output = checked.data;
    touchMcpConnection(ctx.ownerId, ctx.clientId, clock.now());
    return {
      content: [{ type: "text", text: def.text(output) }],
      structuredContent: output as Record<string, unknown>,
    };
  } catch (error) {
    return toolErrorResult(error, def.name, claims.sub ?? "");
  }
}
