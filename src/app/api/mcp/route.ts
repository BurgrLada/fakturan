import { auth } from "@/server/auth";
import { env } from "@/server/env";
import { mcpEndpoint } from "@/server/mcp/server";

// Stateless: no GET stream and no DELETE of a session, so Next answers both with 405 (MCP-035).
export function POST(request: Request): Promise<Response> {
  return mcpEndpoint(auth, env, request);
}
