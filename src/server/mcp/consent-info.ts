import "server-only";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { McpCapability } from "@/lib/mcp-settings";
import type { Env } from "../env";
import { findMcpClient } from "../services/mcp-connections";
import { consentInfo, type ConsentInfo } from "../services/mcp-client-info";
import { allowedCapabilities, getMcpSettings } from "../services/mcp-settings";

export { consentInfo, type ConsentInfo } from "../services/mcp-client-info";

export type ConsentRequest = ConsentInfo & { clientId: string; oauthQuery: string };

function isUrl(value: string): boolean {
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

// The consent page's query is signed by the provider when it redirects there. Anything else, or
// an expired query, or a disabled client, shows no consent.
export async function consentRequest(env: Env, oauthQuery: string): Promise<ConsentRequest | null> {
  if (!(await verifyOAuthQueryParams(oauthQuery, env.BETTER_AUTH_SECRET))) return null;
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  if (!clientId) return null;
  const client = findMcpClient(clientId);
  if (!client || client.disabled) return null;
  const redirectUri = params.get("redirect_uri") ?? "";
  return {
    ...consentInfo({
      clientName: client.name,
      redirectUri,
      clientIdUrl: isUrl(clientId) ? clientId : null,
    }),
    clientId,
    oauthQuery,
  };
}

export type ConsentPage =
  | { kind: "invalid" }
  | { kind: "disabled" }
  | { kind: "consent"; request: ConsentRequest; capabilities: McpCapability[] };

// What /pristup-asistenta shows a signed-in user. With access off the authorization ends here with
// an explanation and no consent (MCP-006); the provider sends the browser here for that too.
export async function consentPage(
  env: Env,
  oauthQuery: string,
  userId: string,
): Promise<ConsentPage> {
  const request = await consentRequest(env, oauthQuery);
  if (!request) return { kind: "invalid" };
  const settings = getMcpSettings(userId);
  if (!settings.enabled) return { kind: "disabled" };
  return { kind: "consent", request, capabilities: allowedCapabilities(settings) };
}
