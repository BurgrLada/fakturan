import { auth } from "@/server/auth";
import { env } from "@/server/env";
import { oauthMetadata } from "@/server/mcp/well-known";

export function GET(request: Request) {
  return oauthMetadata(auth, env, request);
}
