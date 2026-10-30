import "server-only";
import { createHmac } from "node:crypto";
import type { Env } from "../env";

// Keyed, so a leaked audit log cannot be matched against a list of known addresses.
export function emailHash(email: string, env: Pick<Env, "BETTER_AUTH_SECRET">): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(email.toLowerCase()).digest("hex");
}
