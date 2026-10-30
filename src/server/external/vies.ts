import "server-only";
import { env } from "../env";
import type { Fetcher } from "./ares";

export type ViesState = "valid" | "invalid" | "unavailable";

const TIMEOUT_MS = 5_000;

export function splitVatId(dic: string): { country: string; number: string } | null {
  const compact = dic.replace(/\s+/g, "").toUpperCase();
  const match = /^([A-Z]{2})([A-Z0-9]{2,14})$/.exec(compact);
  return match ? { country: match[1], number: match[2] } : null;
}

// Unavailability is never an error: it must not block saving the customer (CUS-005).
export async function lookupVies(
  dic: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<ViesState> {
  const parts = splitVatId(dic);
  if (!parts) return "unavailable";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(`${env.VIES_BASE_URL}/ms/${parts.country}/vat/${parts.number}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return "unavailable";
    const body = (await response.json()) as { isValid?: unknown; userError?: unknown };
    // VIES answers isValid=false together with an error code when the member state is down.
    if (typeof body.isValid !== "boolean") return "unavailable";
    if (!body.isValid && typeof body.userError === "string" && body.userError !== "INVALID") {
      return "unavailable";
    }
    return body.isValid ? "valid" : "invalid";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
