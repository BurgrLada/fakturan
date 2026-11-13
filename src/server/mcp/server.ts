import "server-only";
import { requireMcpAuth } from "@better-auth/mcp";
import {
  createMcpHandler,
  McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import { TEXTS } from "@/lib/texts";
import type { Auth } from "../auth";
import type { Env } from "../env";
import { levelAtLeast } from "@/lib/mcp-settings";
import { activeLevel, getMcpSettings } from "../services/mcp-settings";
import { isMcpAccountActive, isMcpConnected } from "../services/mcp-connections";
import { isMcpAvailable, MCP_SCOPE, mcpResource } from "./availability";
import { mcpRateLimit } from "./rate-limit";
import { runTool, TOOLS, type McpClaims } from "./tool";
import "./tools";

// The schema is advertised in tools/list, but the arguments reach runTool unchecked: the SDK would
// otherwise validate them before the access checks and answer in English (MCP-012).
function advertised(schema: z.ZodType): StandardSchemaWithJSON {
  return {
    "~standard": {
      version: 1,
      vendor: "fakturan",
      validate: (value) => ({ value }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
}

// One server per request (MCP-035). Only the tools of the user's current level are listed; with the
// access off or the client disconnected the list is empty (MCP-053). A tools/call request gets every
// tool registered, so a tool from an older list reaches runTool and is refused there in Czech
// (MCP-052) instead of the SDK's "tool not found".
export function buildMcpServer(
  claims: McpClaims,
  env: Env,
  { allTools = false }: { allTools?: boolean } = {},
): McpServer {
  const ownerId = claims.sub ?? "";
  const clientId = claims.azp ?? claims.client_id;
  const active =
    ownerId && clientId && isMcpAccountActive(ownerId) && isMcpConnected(ownerId, clientId)
      ? activeLevel(getMcpSettings(ownerId))
      : null;
  const server = new McpServer(
    { name: "fakturan", title: "Fakturan", version: "1.0.0" },
    {
      // Declared also for an empty list, so tools/list answers instead of "method not found".
      capabilities: { tools: {} },
      ...(active ? { instructions: TEXTS.mcp.instructions(TEXTS.mcp.levels[active].name) } : {}),
    },
  );
  for (const def of TOOLS) {
    if (!allTools && !(active && levelAtLeast(active, def.level))) continue;
    const hint = def.level === "full" ? "" : ` ${TEXTS.mcp.tools.higherLevelHint}`;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description + hint,
        inputSchema: advertised(def.input),
        outputSchema: advertised(def.output),
        annotations: {
          readOnlyHint: def.level === "read",
          destructiveHint: def.level === "full",
          openWorldHint: false,
        },
      },
      (args) => runTool(def, claims, args, env),
    );
  }
  return server;
}

// Whether the JSON-RPC request is a tools/call; an unreadable body is not (the SDK answers it).
async function isToolCall(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    return (body as { method?: unknown } | null)?.method === "tools/call";
  } catch {
    return false;
  }
}

const ISSUER_PATH = "/api/auth";

// MCP-032: a plain HTTP 429, with the JSON-RPC error body the auth challenges use too.
function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: TEXTS.mcp.tools.rateLimited(retryAfterSeconds) },
      id: null,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

// POST /api/mcp. The token is checked by Better Auth (signature, issuer, audience, expiry); a request
// without one gets 401 with the RFC 9728 challenge (MCP-034). The challenge also names
// offline_access, so a client that takes its scope from it receives a refresh token (MCP-007).
export async function mcpEndpoint(auth: Auth, env: Env, request: Request): Promise<Response> {
  if (!isMcpAvailable(env)) return new Response(null, { status: 404 });
  const issuer = new URL(ISSUER_PATH, env.BETTER_AUTH_URL).href;
  const handler = requireMcpAuth(
    auth,
    (req, raw) => {
      const claims = raw as McpClaims;
      const clientId = claims.azp ?? claims.client_id;
      const retryAfter = claims.sub && clientId ? mcpRateLimit(claims.sub, clientId) : null;
      if (retryAfter !== null) return tooManyRequests(retryAfter);
      return isToolCall(req).then((allTools) =>
        createMcpHandler(() => buildMcpServer(claims, env, { allTools }), {
          legacy: "stateless",
        }).fetch(req),
      );
    },
    {
      resource: mcpResource(env),
      issuer,
      jwksUrl: `${issuer}/jwks`,
      requiredScopes: [MCP_SCOPE],
      challengeScopes: [MCP_SCOPE, "offline_access"],
    },
  );
  return handler(request);
}
