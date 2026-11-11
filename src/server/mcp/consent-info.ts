import "server-only";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { eq } from "drizzle-orm";
import { TEXTS } from "@/lib/texts";
import type { Db } from "../db";
import { oauthClient } from "../db/schema";
import type { Env } from "../env";

const C = TEXTS.mcp.consent;
const NAME_LIMIT = 80; // název nejvýš 80 znaků (MCP-005)
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ConsentInfo = { name: string; host: string; nameIsClaimed: true };

function hostname(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

// The client names itself and chooses its callback, so both are untrusted text: shortened, never
// parsed, and the page says the name is the client's own claim (MCP-005, MCP-044).
export function consentInfo(input: {
  clientName: string | null;
  redirectUri: string;
  clientIdUrl: string | null;
}): ConsentInfo {
  const cleaned = (input.clientName ?? "").replace(/\s+/g, " ").trim();
  const name = cleaned ? [...cleaned].slice(0, NAME_LIMIT).join("") : C.unknownClient;
  // A metadata document (CIMD) is fetched from its own host, which is what vouches for the client.
  const host = hostname(input.clientIdUrl) ?? hostname(input.redirectUri) ?? "";
  return { name, host: LOOPBACK.has(host) ? C.localHost : host, nameIsClaimed: true };
}

export type ConsentRequest = ConsentInfo & { clientId: string; oauthQuery: string };

function isUrl(value: string): boolean {
  return hostname(value) !== null;
}

// The consent page's query is signed by the provider when it redirects there. Anything else, or
// an expired query, or a disabled client, shows no consent.
export async function consentRequest(
  db: Db,
  env: Env,
  oauthQuery: string,
): Promise<ConsentRequest | null> {
  if (!(await verifyOAuthQueryParams(oauthQuery, env.BETTER_AUTH_SECRET))) return null;
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  if (!clientId) return null;
  const client = db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).get();
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
