import "server-only";
import { lookupAres, type AresResult } from "../external/ares";
import type { Actor } from "../audit/context";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit } from "./access";

// The company register behind the IČO field, under the per-user ARES limit.
export async function lookupCompany(actor: Actor, ico: string): Promise<AresResult | null> {
  enforceRateLimit(actor, RATE_RULES.aresLookup);
  return lookupAres(ico);
}
