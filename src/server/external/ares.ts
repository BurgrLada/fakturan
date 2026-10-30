import "server-only";
import { isValidIco } from "@/lib/ico";

export type AresResult = {
  ico: string;
  name: string;
  dic: string;
  street: string;
  city: string;
  zip: string;
  country: string;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty";
const TIMEOUT_MS = 5_000;

type Sidlo = {
  nazevStatu?: string;
  nazevObce?: string;
  nazevCastiObce?: string;
  nazevUlice?: string;
  cisloDomovni?: number;
  cisloOrientacni?: number;
  cisloOrientacniPismeno?: string;
  psc?: number;
};

type AresReply = { ico?: string; obchodniJmeno?: string; dic?: string; sidlo?: Sidlo };

function streetOf(sidlo: Sidlo): string {
  const orientation = sidlo.cisloOrientacni
    ? `/${sidlo.cisloOrientacni}${sidlo.cisloOrientacniPismeno ?? ""}`
    : "";
  const number = sidlo.cisloDomovni ? `${sidlo.cisloDomovni}${orientation}` : "";
  const place = sidlo.nazevUlice || sidlo.nazevCastiObce || sidlo.nazevObce || "";
  return [place, number].filter(Boolean).join(" ");
}

function zipOf(psc: number | undefined): string {
  const digits = psc ? String(psc).padStart(5, "0") : "";
  return digits ? `${digits.slice(0, 3)} ${digits.slice(3)}` : "";
}

// Unavailability is never an error: the caller falls back to manual entry (CUS-004).
export async function lookupAres(
  ico: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<AresResult | null> {
  if (!isValidIco(ico)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(`${BASE}/${ico}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as AresReply;
    if (!body.obchodniJmeno) return null;
    const sidlo = body.sidlo ?? {};
    return {
      ico: body.ico ?? ico,
      name: body.obchodniJmeno,
      dic: body.dic ?? "",
      street: streetOf(sidlo),
      city: sidlo.nazevObce ?? "",
      zip: zipOf(sidlo.psc),
      country: sidlo.nazevStatu ?? "",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
