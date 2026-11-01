import "server-only";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { daysBetween } from "@/lib/invoice";
import { convertMinor, expectedListDate, RATE_UNIT, type ExchangeRateSource } from "@/lib/fx";
import {
  calendarDateInPrague,
  isCalendarDate,
  timeInPrague,
  type CalendarDate,
} from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { clock } from "../clock";
import { db } from "../db";
import { exchangeRate, type Job } from "../db/schema";
import { fetchDailyRates } from "../external/cnb";
import type { Fetcher } from "../external/ares";
import { reportFailure } from "../scheduler/report";
import { enqueueStandalone } from "../jobs/queue";
import { RATE_RULES } from "../rate-limit";
import { enforceRateLimit, RateLimitError, ServiceError, type Reader } from "./access";
import { findOwned, ownerOf, Unchanged, unlessUnchanged } from "./invoices";
import { mutate } from "./mutation";
import { getPreferences } from "./preferences";

const E = TEXTS.exchangeRates.errors;

const SYSTEM: Actor = { userId: null, source: "system" };
const FETCH_FROM = "14:45";
const STALE_AFTER_DAYS = 5;

export type RateResult = {
  rateMicros: number;
  source: Exclude<ExchangeRateSource, "manual">;
  listDate: CalendarDate | null;
  reference: number | null;
} | null;

type Listed = { rateMicros: number; listDate: CalendarDate; exact: boolean };

function storedRate(q: Reader, currency: Currency, date: CalendarDate): number | null {
  const row = q
    .select({ rateMicros: exchangeRate.rateMicros })
    .from(exchangeRate)
    .where(and(eq(exchangeRate.currency, currency), eq(exchangeRate.listDate, date)))
    .get();
  return row?.rateMicros ?? null;
}

function listedRate(q: Reader, currency: Currency, expected: CalendarDate): Listed | null {
  const exact = storedRate(q, currency, expected);
  if (exact !== null) return { rateMicros: exact, listDate: expected, exact: true };
  const earlier = q
    .select({ rateMicros: exchangeRate.rateMicros, listDate: exchangeRate.listDate })
    .from(exchangeRate)
    .where(and(eq(exchangeRate.currency, currency), lt(exchangeRate.listDate, expected)))
    .orderBy(desc(exchangeRate.listDate))
    .limit(1)
    .get();
  return earlier ? { ...earlier, exact: false } : null;
}

// Reads stored rows only, so issuing and paying never wait for the network (R-11).
export function resolveRate(
  q: Reader,
  ownerId: string,
  currency: Currency,
  date: CalendarDate,
  now: Date,
): RateResult {
  if (currency === "CZK") return null;
  const listed = listedRate(q, currency, expectedListDate(date, now));
  const fixed = getPreferences(ownerId).fixedRates[currency];
  if (fixed) {
    return {
      rateMicros: fixed,
      source: "fixed",
      listDate: null,
      reference: listed?.exact ? listed.rateMicros : null,
    };
  }
  if (!listed) return null;
  return {
    rateMicros: listed.rateMicros,
    source: listed.exact ? "cnb" : "last_known",
    listDate: listed.listDate,
    reference: listed.rateMicros,
  };
}

// Without a fixed rate: reports and payments follow the bank's list, not the account's own choice.
export function cnbRate(q: Reader, currency: Currency, date: CalendarDate): number | null {
  if (currency === "CZK") return RATE_UNIT;
  return storedRate(q, currency, expectedListDate(date, clock.now()));
}

// Never throws: a missing rate only means the caller falls back to the last known one or to manual entry.
// An unavailable list is the normal case and stays silent; only a failure to store one is reported.
export async function ensureRate(
  currency: Currency,
  date: CalendarDate,
  fetcher?: Fetcher,
): Promise<void> {
  try {
    if (currency === "CZK") return;
    const expected = expectedListDate(date, clock.now());
    if (storedRate(db, currency, expected) !== null) return;
    const parsed = await fetchDailyRates(expected, fetcher);
    if (!parsed) return;
    unlessUnchanged(() =>
      mutate(SYSTEM, "exchange_rate.fetch", (tx, audit) => {
        const fetchedAt = clock.now();
        const stored = tx
          .insert(exchangeRate)
          .values(
            parsed.rates.map(({ currency: code, rateMicros }) => ({
              currency: code,
              listDate: parsed.listDate,
              rateMicros,
              fetchedAt,
            })),
          )
          .onConflictDoNothing()
          .returning({ currency: exchangeRate.currency })
          .all();
        if (stored.length === 0) throw new Unchanged(undefined);
        audit({
          entity: "exchange_rate",
          entityId: null,
          ownerId: null,
          scope: "instance",
          after: { listDate: parsed.listDate, currencies: stored.length },
        });
      }),
    );
  } catch (error) {
    reportFailure(error, { task: "fx" });
  }
}

const lookupSchema = z.object({
  currency: z.enum(CURRENCIES, E.invalid),
  date: z.string(E.invalid).refine(isCalendarDate, E.invalid),
});

function parseLookup(raw: { currency: string; date: string }) {
  const parsed = lookupSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  return parsed.data;
}

// A rate limit is not an error here: the form simply keeps the last known rate.
async function mayFetch(actor: Actor): Promise<boolean> {
  try {
    enforceRateLimit(actor, RATE_RULES.fxLookupUser);
    return true;
  } catch (error) {
    if (error instanceof RateLimitError) return false;
    throw error;
  }
}

export async function loadRate(
  actor: Actor,
  raw: { currency: string; date: string },
  fetcher?: Fetcher,
): Promise<RateResult> {
  const ownerId = ownerOf(actor);
  const { currency, date } = parseLookup(raw);
  const first = resolveRate(db, ownerId, currency, date, clock.now());
  if (first && (first.source === "cnb" || first.source === "fixed")) return first;
  if (!(await mayFetch(actor))) return first;
  await ensureRate(currency, date, fetcher);
  return resolveRate(db, ownerId, currency, date, clock.now());
}

const creditSchema = z.object({
  invoiceId: z.string(E.invalid).min(1, E.invalid),
  currency: z.enum(CURRENCIES, E.invalid),
  amountMinor: z.number(E.invalid).int(E.invalid).positive(E.invalid),
  paidOn: z.string(E.invalid).refine(isCalendarDate, E.invalid),
});

// The amount credited to the invoice when the money came in another currency, both converted
// through CZK on the day of payment (PAY-006). Null means the form asks for a manual amount.
export async function creditPreview(
  actor: Actor,
  raw: { invoiceId: string; currency: string; amountMinor: number; paidOn: string },
  fetcher?: Fetcher,
): Promise<{ creditedMinor: number } | null> {
  const ownerId = ownerOf(actor);
  const parsed = creditSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(parsed.error.issues[0]?.message ?? E.invalid);
  const { invoiceId, currency, amountMinor, paidOn } = parsed.data;
  const invoiceCurrency = findOwned(db, ownerId, invoiceId).currency;
  if (currency === invoiceCurrency) return { creditedMinor: amountMinor };

  const pair = [currency, invoiceCurrency] as const;
  if (pair.some((code) => cnbRate(db, code, paidOn) === null) && (await mayFetch(actor))) {
    for (const code of pair) await ensureRate(code, paidOn, fetcher);
  }
  const [from, to] = pair.map((code) => cnbRate(db, code, paidOn));
  if (from === null || to === null) return null;
  return { creditedMinor: convertMinor(amountMinor, from!, to!) };
}

function hasListFor(expected: CalendarDate): boolean {
  return storedRate(db, "EUR", expected) !== null;
}

let reportedStaleOn: CalendarDate | null = null;

// An outage is not an error, but a list that stays unreadable for days means the source changed
// its format, and only the code can fix that.
function reportStale(expected: CalendarDate, today: CalendarDate): void {
  const newest = db
    .select({ listDate: sql<string | null>`max(${exchangeRate.listDate})` })
    .from(exchangeRate)
    .where(eq(exchangeRate.currency, "EUR"))
    .get()?.listDate;
  if (!newest || reportedStaleOn === today) return;
  const days = daysBetween(newest, expected);
  if (days < STALE_AFTER_DAYS) return;
  reportedStaleOn = today;
  reportFailure(new Error(`Kurzy ČNB se už ${days} dní nepodařilo načíst`), { task: "fx" });
}

function tableIsEmpty(): boolean {
  return (
    db
      .select({ one: sql`1` })
      .from(exchangeRate)
      .limit(1)
      .get() === undefined
  );
}

// One job per hour until the expected list is stored; the first run on an empty instance goes at once.
export function planRateFetch(now: Date): void {
  const today = calendarDateInPrague(now);
  const expected = expectedListDate(today, now);
  if (hasListFor(expected)) return;
  reportStale(expected, today);
  const waiting = expected === today && timeInPrague(now) < FETCH_FROM;
  if (waiting && !tableIsEmpty()) return;
  const hour = timeInPrague(now).slice(0, 2);
  enqueueStandalone({
    kind: "fx.fetch",
    key: `fx:${expected}:${hour}`,
    userId: null,
    payload: { date: expected },
    maxAttempts: 1,
  });
}

export async function runRateFetch(job: Job): Promise<void> {
  const date = String(job.payload.date);
  if (!isCalendarDate(date)) return;
  await ensureRate("EUR", date);
}
