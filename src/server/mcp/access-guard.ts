import "server-only";
import { createHash } from "node:crypto";
import type { GenericEndpointContext } from "better-auth";
import { APIError, getSessionFromCtx, isAPIError } from "better-auth/api";
import { TEXTS } from "@/lib/texts";
import { webActor } from "../auth/request-actor";
import type { Env } from "../env";
import { recordMcpConnected } from "../services/mcp-connections";
import { getMcpSettings } from "../services/mcp-settings";

type Ctx = GenericEndpointContext;

export const MCP_DISABLED = "MCP_DISABLED";

export function isMcpAccessEnabled(userId: string): boolean {
  return getMcpSettings(userId).enabled;
}

// The oauth-provider plugin's postLogin step runs inside every authorization, including the one
// it re-runs after a sign-in. While access is off it sends the browser to the consent page, which
// then shows the explanation instead of the consent (MCP-006).
export const mcpPostLogin = {
  page: "/pristup-asistenta",
  consentReferenceId: () => undefined,
  shouldRedirect: ({ user }: { user: { id: string } }) => !isMcpAccessEnabled(user.id),
};

function disabledForConsent(): APIError {
  return new APIError("FORBIDDEN", {
    code: MCP_DISABLED,
    message: TEXTS.mcp.disabled.title,
    error: "access_denied",
    error_description: "assistant access is disabled",
  });
}

// How the plugin stores an authorization code: SHA-256, base64url without padding (storeTokens
// "hashed", its default). A change there makes the MCP-006 token test fail, not pass silently.
function storedCode(code: string): string {
  return createHash("sha256").update(code).digest("base64url");
}

async function codeOwner(ctx: Ctx, code: string): Promise<string | null> {
  const row = await ctx.context.internalAdapter.findVerificationValue(storedCode(code));
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as { type?: unknown; userId?: unknown };
    return value.type === "authorization_code" && typeof value.userId === "string"
      ? value.userId
      : null;
  } catch {
    return null;
  }
}

// Before hook for the OAuth endpoints (MCP-006, MCP-010). The postLogin step covers authorize; this
// covers what skips it: the consent endpoint (its query carries the plugin's "post-login done"
// mark), the post-login continuation, and a code handed out just before access was switched off.
// The refresh grant stays open: switching off keeps the connection (MCP-010) and the MCP endpoint
// refuses every call by itself (MCP-012).
export async function guardMcpAccess(ctx: Ctx): Promise<void> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const grantsAccess =
    (ctx.path === "/oauth2/consent" && body.accept === true) || ctx.path === "/oauth2/continue";
  if (grantsAccess) {
    const session = await getSessionFromCtx(ctx, { disableRefresh: true });
    if (session && !isMcpAccessEnabled(session.user.id)) throw disabledForConsent();
    return;
  }
  if (
    ctx.path === "/oauth2/token" &&
    body.grant_type === "authorization_code" &&
    typeof body.code === "string"
  ) {
    const owner = await codeOwner(ctx, body.code);
    if (owner && !isMcpAccessEnabled(owner)) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_grant",
        error_description: "assistant access is disabled",
      });
    }
  }
}

function redirectTarget(returned: unknown): string | null {
  if (isAPIError(returned)) return new Headers(returned.headers).get("location");
  const url = (returned as { url?: unknown } | null)?.url;
  return typeof url === "string" ? url : null;
}

// After hook: an accepted consent that ended with a code for the client is the grant (MCP-031).
export async function auditMcpConsent(ctx: Ctx, env: Env): Promise<void> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (ctx.path !== "/oauth2/consent" || body.accept !== true) return;
  const target = redirectTarget((ctx.context as { returned?: unknown }).returned);
  if (!target || !new URL(target, env.BETTER_AUTH_URL).searchParams.has("code")) return;
  const query = typeof body.oauth_query === "string" ? body.oauth_query : "";
  const clientId = new URLSearchParams(query).get("client_id");
  const session = await getSessionFromCtx(ctx, { disableRefresh: true });
  if (!clientId || !session) return;
  recordMcpConnected(webActor(ctx.headers, session.user.id, env), clientId);
}
