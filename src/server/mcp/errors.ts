import "server-only";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import type { McpLevel } from "@/lib/mcp-settings";
import { TEXTS } from "@/lib/texts";
import { logger } from "../logger";
import { scrubText } from "../monitoring/before-send";
import { ServiceError } from "../services/access";
import type { McpCallReason } from "../services/mcp-call-log";

// A refusal or failure the assistant should relay to the user. The message is Czech and shown as is;
// `details` go with it as structured content, e.g. the problems that stop issuing (MCP-073).
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// A refusal by the access checks, with the code the call log keeps (MCP-061, MCP-067).
export class McpDenied extends McpToolError {
  constructor(
    message: string,
    readonly reason: McpCallReason,
    readonly requiredLevel: McpLevel | null = null,
  ) {
    super(message);
  }
}

export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

// Field names a tool gives in Czech: "lines.0.quantity" reads "položky 1 › množství".
export type FieldLabels = Readonly<Record<string, string>>;

function labelledPath(path: PropertyKey[], labels: FieldLabels): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === "number" && parts.length > 0) {
      parts[parts.length - 1] += ` ${segment + 1}`;
    } else {
      parts.push(labels[String(segment)] ?? String(segment));
    }
  }
  return parts.join(" › ");
}

function issuesText(error: z.ZodError, labels?: FieldLabels): string {
  return error.issues
    .map((issue) => {
      const path = [...issue.path];
      if (issue.code === "unrecognized_keys") path.push(issue.keys.join(", "));
      if (!path.length) return issue.message;
      const where = labels ? labelledPath(path, labels) : path.map(String).join(".");
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

// Only the tool name and the user id leave the instance, never the arguments or the output (MCP-036).
function reportMcpFailure(error: unknown, tool: string, userId: string): void {
  const [name, message] =
    error instanceof Error ? [error.name, error.message] : ["", String(error)];
  logger.error("selhání nástroje MCP", {
    tool,
    userId,
    error: { name, message: scrubText(message) },
  });
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureException(error, { tags: { "mcp.tool": tool }, user: { id: userId } });
}

// What a tool call returns when it throws: the user's own mistakes and refusals as a sentence, our
// bugs as a general one.
export function toolErrorResult(
  error: unknown,
  tool: string,
  userId: string,
  labels?: FieldLabels,
): CallToolResult {
  // The web says to reload the page; an assistant reads the invoice again instead (MCP-072).
  if (error instanceof ServiceError && error.message === TEXTS.invoices.stale) {
    return toolError(TEXTS.mcp.tools.stale);
  }
  if (error instanceof McpToolError && error.details) {
    return { ...toolError(error.message), structuredContent: error.details };
  }
  if (error instanceof McpToolError || error instanceof ServiceError) {
    return toolError(error.message);
  }
  if (error instanceof z.ZodError) {
    return toolError(TEXTS.mcp.tools.invalidInput(issuesText(error, labels)));
  }
  reportMcpFailure(error, tool, userId);
  return toolError(TEXTS.mcp.tools.failed);
}
