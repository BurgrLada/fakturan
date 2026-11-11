import "server-only";
import type { AuthContext } from "better-auth";
import type { Auth } from "../auth";
import type { Env } from "../env";
import { isMcpAvailable } from "./availability";

// MCP clients look for /.well-known/oauth-authorization-server/api/auth and
// /.well-known/oauth-protected-resource/api/mcp at the domain root (RFC 8414, RFC 9728). The mcp
// plugin serves both from its onRequest hook, but Better Auth's router answers 404 to anything
// outside /api/auth before that hook runs, so the root routes hand the request to the hook directly.
// Any other path below .well-known stays a 404, as does everything when MCP is off.
export async function oauthMetadata(auth: Auth, env: Env, request: Request): Promise<Response> {
  if (!isMcpAvailable(env)) return notFound();
  // The instance's context is typed for its own options, plugin hooks for the general ones; the
  // object is the same.
  const context = (await auth.$context) as unknown as AuthContext;
  const result = await context.getPlugin("oauth-provider")?.onRequest?.(request, context);
  return result && "response" in result ? result.response : notFound();
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}
