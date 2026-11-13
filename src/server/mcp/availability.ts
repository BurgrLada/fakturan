import "server-only";
import type { Env } from "../env";

export const MCP_SCOPE = "fakturan";

// The demo login is public, so an assistant connected to it would act for every visitor (MCP-009);
// MCP_ENABLED turns it off for a whole instance the same way (MCP-038).
export function isMcpAvailable(env: Env): boolean {
  return !env.DEMO_MODE && env.MCP_ENABLED;
}

// The token audience and the protected resource identifier; both must match exactly (MCP-007).
export function mcpResource(env: Env): string {
  return new URL("/api/mcp", env.BETTER_AUTH_URL).href;
}
