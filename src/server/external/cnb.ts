import "server-only";
import { parseDailyRates, type ParsedRates } from "@/lib/cnb-rates";
import type { CalendarDate } from "@/lib/number-format";
import { env } from "../env";
import type { Fetcher } from "./ares";

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;

function queryDate(date: CalendarDate): string {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

async function readLimited(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BYTES || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// CNB answers a weekend or a future date with the latest list, so the list's own date decides, and
// one dated after the requested day is refused. Unavailability is never an error: the caller falls
// back to the last known rate or manual entry.
export async function fetchDailyRates(
  date: CalendarDate,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<ParsedRates | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(`${env.CNB_BASE_URL}/denni_kurz.txt?date=${queryDate(date)}`, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    if (!response.ok) return null;
    const text = await readLimited(response);
    const parsed = text === null ? null : parseDailyRates(text);
    return parsed && parsed.listDate <= date ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
