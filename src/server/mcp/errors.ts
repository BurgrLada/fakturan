import "server-only";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { logger } from "../logger";
import { scrubText } from "../monitoring/before-send";
import { ServiceError } from "../services/access";

// A refusal or failure the assistant should relay to the user. The message is Czech and shown as is.
export class McpToolError extends Error {}

export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = [...issue.path];
      if (issue.code === "unrecognized_keys") path.push(issue.keys.join(", "));
      return path.length ? `${path.map(String).join(".")}: ${issue.message}` : issue.message;
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
export function toolErrorResult(error: unknown, tool: string, userId: string): CallToolResult {
  if (error instanceof McpToolError || error instanceof ServiceError) {
    return toolError(error.message);
  }
  if (error instanceof z.ZodError) {
    return toolError(TEXTS.mcp.tools.invalidInput(issuesText(error)));
  }
  reportMcpFailure(error, tool, userId);
  return toolError(TEXTS.mcp.tools.failed);
}
