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
import { capabilitiesOf, getMcpSettings } from "../services/mcp-settings";
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

// One server per request (MCP-035). Every tool is listed, also one whose capability is off, so the
// assistant can tell the user what to switch on and the list does not change under it (MCP-025).
export function buildMcpServer(claims: McpClaims, env: Env): McpServer {
  const server = new McpServer({ name: "fakturan", title: "Fakturan", version: "1.0.0" });
  const allowed = capabilitiesOf(getMcpSettings(claims.sub ?? ""));
  for (const def of TOOLS) {
    const off = allowed.includes(def.capability) ? "" : TEXTS.mcp.tools.offSuffix;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description + off,
        inputSchema: advertised(def.input),
        outputSchema: advertised(def.output),
        annotations: { readOnlyHint: def.capability === "read", openWorldHint: false },
      },
      (args) => runTool(def, claims, args, env),
    );
  }
  return server;
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
      return createMcpHandler(() => buildMcpServer(claims, env), { legacy: "stateless" }).fetch(
        req,
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
