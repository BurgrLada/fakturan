import "server-only";
import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { levelAtLeast, type McpLevel } from "@/lib/mcp-settings";
import { calendarDateInPrague, type CalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { czechError } from "@/lib/validation-issue";
import { runWithActor, type Actor } from "../audit/context";
import { clock } from "../clock";
import type { Env } from "../env";
import { isMcpAccountActive, isMcpConnected, mcpClientName } from "../services/mcp-connections";
import type { McpCallOutcome, McpCallReason } from "../services/mcp-call-log";
import { recordMcpCall, touchMcpConnection } from "../mcp-usage";
import { activeLevel, getMcpSettings } from "../services/mcp-settings";
import { isMcpAvailable } from "./availability";
import {
  McpDenied,
  McpToolError,
  reportMcpFailure,
  toolErrorResult,
  type FieldLabels,
} from "./errors";

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
  // The user's level at the time of the call.
  level: McpLevel;
};

// A tool is a Zod input, a Zod output, the level it needs and a call into a service (ARC-001).
export type ToolDef<I, O> = {
  name: string;
  title: string;
  description: string;
  // The minimum level, checked before the input is read (MCP-052).
  level: McpLevel;
  // A higher level derived from the valid input (MCP-051): a pure choice, no side effects.
  levelFor?: (ctx: ToolContext, input: I) => McpLevel;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run: (ctx: ToolContext, input: I) => O | Promise<O>;
  // The text for the model; values from documents must stay visibly data (MCP-033).
  text: (output: O) => string;
  // Czech names of the input fields, for the list of invalid ones.
  fieldLabels?: FieldLabels;
};

// The verified access token claims the wrapper needs: the user and the OAuth client.
export type McpClaims = { sub?: string; azp?: string; client_id?: string };

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

// Every tool the endpoint serves; each has its own input and output types. Tool modules add
// themselves here.
export const TOOLS: ToolDef<any, any>[] = [];

// The checks of MCP-012 and MCP-052, in this order, on every call: nothing is trusted from the
// connection time. The input is validated only after the minimum level, in runTool.
// The rate limit (MCP-032) is checked before this, per HTTP request in mcpEndpoint.
function admit(
  def: ToolDef<unknown, unknown>,
  claims: McpClaims,
  env: Env,
  requestId: string,
): ToolContext {
  if (!isMcpAvailable(env)) throw new McpDenied(T.unavailable, "unavailable");
  const ownerId = claims.sub;
  // Not logged: there is no account to log it for (MCP-061).
  if (!ownerId || !isMcpAccountActive(ownerId)) throw new McpToolError(T.noAccount);
  const settings = getMcpSettings(ownerId);
  if (!settings.enabled) throw new McpDenied(T.disabled, "disabled");
  const clientId = claims.azp ?? claims.client_id;
  // JWT access tokens are not stored, so disconnecting cannot revoke them: the consent row decides.
  if (!clientId || !isMcpConnected(ownerId, clientId)) {
    throw new McpDenied(T.notConnected, "not_connected");
  }
  const level = activeLevel(settings)!;
  requireLevel(level, def.level);
  const clientName = mcpClientName(clientId);
  const actor: Actor = {
    userId: ownerId,
    source: "mcp",
    clientId,
    clientName,
    requestId,
  };
  return {
    ownerId,
    actor,
    clientId,
    clientName,
    baseUrl: new URL(env.BETTER_AUTH_URL).origin,
    today: calendarDateInPrague(clock.now()),
    level,
  };
}

function requireLevel(have: McpLevel, need: McpLevel): void {
  if (!levelAtLeast(have, need)) {
    throw new McpDenied(T.levelTooLow(TEXTS.mcp.levels[need].name), "level", need);
  }
}

type Logged = {
  outcome: McpCallOutcome;
  reason: McpCallReason | null;
  requiredLevel: McpLevel | null;
};

// How a failed call ends in the log: a refusal by the checks, bad input, or anything else.
function loggedFailure(error: unknown): Logged {
  if (error instanceof McpDenied) {
    return { outcome: "denied", reason: error.reason, requiredLevel: error.requiredLevel };
  }
  if (error instanceof z.ZodError) {
    return { outcome: "error", reason: "invalid_input", requiredLevel: null };
  }
  return { outcome: "error", reason: "service_error", requiredLevel: null };
}

// Every call of a known, active account goes to the call log (MCP-061); the log decides itself
// whether it is switched on (MCP-062).
function logCall(
  def: { name: string },
  claims: McpClaims,
  requestId: string,
  logged: Logged,
): void {
  try {
    const ownerId = claims.sub;
    if (!ownerId || !isMcpAccountActive(ownerId)) return;
    const clientId = claims.azp ?? claims.client_id ?? "";
    recordMcpCall({
      ownerId,
      clientId,
      clientName: clientId ? mcpClientName(clientId) : TEXTS.mcp.consent.unknownClient,
      tool: def.name,
      requestId,
      at: clock.now(),
      ...logged,
    });
  } catch {
    // recordMcpCall reports its own failures; the lookups above must not change the result either.
  }
}

function finished<I, O>(
  def: ToolDef<I, O>,
  ownerId: string,
  clientId: string,
  result: O,
): CallToolResult {
  const report = (error: unknown) => reportMcpFailure(error, def.name, ownerId);
  // The SDK refuses a success without valid structured content, so a summary we cannot build is
  // marked as an error whose text says the change happened and must not be repeated.
  const unsummarized: CallToolResult = {
    isError: true,
    content: [{ type: "text", text: TEXTS.mcp.tools.doneWithoutSummary }],
  };
  try {
    touchMcpConnection(ownerId, clientId, clock.now());
  } catch (error) {
    report(error);
  }
  // A mismatch is our bug, not the user's input: it goes to Sentry.
  const checked = def.output.safeParse(result);
  if (!checked.success) {
    report(new Error(`Výstup nástroje ${def.name} neodpovídá schématu`));
    return unsummarized;
  }
  try {
    return {
      content: [{ type: "text", text: def.text(checked.data) }],
      structuredContent: checked.data as Record<string, unknown>,
    };
  } catch (error) {
    report(error);
    return unsummarized;
  }
}

export async function runTool<I, O>(
  def: ToolDef<I, O>,
  claims: McpClaims,
  raw: unknown,
  env: Env,
): Promise<CallToolResult> {
  const requestId = randomUUID();
  let logged: Logged = { outcome: "ok", reason: null, requiredLevel: null };
  try {
    const ctx = admit(def as ToolDef<unknown, unknown>, claims, env, requestId);
    const input = def.input.parse(raw, { error: czechError });
    if (def.levelFor) requireLevel(ctx.level, def.levelFor(ctx, input));
    const result = await runWithActor(ctx.actor, () => def.run(ctx, input));
    // From here the change is saved: a later failure is reported, never answered as an error,
    // or the assistant would repeat a payment or a new draft.
    return finished(def, ctx.ownerId, ctx.clientId, result);
  } catch (error) {
    logged = loggedFailure(error);
    return toolErrorResult(error, def.name, claims.sub ?? "", def.fieldLabels);
  } finally {
    logCall(def, claims, requestId, logged);
  }
}
