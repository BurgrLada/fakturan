import { TEXTS } from "@/lib/texts";

const C = TEXTS.mcp.consent;
const NAME_LIMIT = 80; // název nejvýš 80 znaků (MCP-005)
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Bidi controls and zero-width characters: the name is the one thing the user judges on the
// consent page, so it must not be able to hide or reorder text.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/gu;

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
  const cleaned = (input.clientName ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const name = cleaned ? [...cleaned].slice(0, NAME_LIMIT).join("") : C.unknownClient;
  // A metadata document (CIMD) is fetched from its own host, which is what vouches for the client.
  const host = hostname(input.clientIdUrl) ?? hostname(input.redirectUri) ?? "";
  return { name, host: LOOPBACK.has(host) ? C.localHost : host, nameIsClaimed: true };
}
