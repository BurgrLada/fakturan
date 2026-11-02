import type { CalendarDate } from "@/lib/number-format";
import type { TurnoverBasis } from "@/lib/preferences";
import {
  effectiveLimit,
  LIMIT_KEYS,
  limitLevel,
  limitPercent,
  type LimitKey,
  type LimitLevel,
} from "@/lib/turnover-limits";
import { preferences } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "../services/access";
import { incomeTotal, taxableTurnover, type SnapshotReader } from "./queries";
import type { Unconverted } from "./types";

export type Turnover = { minor: number; unconverted: Unconverted };

export type LimitState = {
  key: LimitKey;
  limitMinor: number;
  turnoverMinor: number;
  percent: number;
  level: LimitLevel;
  unconverted: Unconverted;
};

export function turnover(q: Reader, ownerId: string, year: number, basis: TurnoverBasis): Turnover {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`Neplatný rok: ${year}`);
  }
  const range: { from: CalendarDate; to: CalendarDate } = {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
  const result =
    basis === "paid"
      ? incomeTotal(q, ownerId, { range, includeExternal: true })
      : taxableTurnover(q, ownerId, range);
  return { minor: result.amountMinor, unconverted: result.unconverted };
}

export function limitStates(q: SnapshotReader, ownerId: string, year: number): LimitState[] {
  return q.transaction(
    (tx: Reader) => {
      const row = tx
        .select({
          vat: preferences.turnoverVatLimitMinor,
          flat: preferences.turnoverFlatLimitMinor,
          basis: preferences.turnoverBasis,
        })
        .from(preferences)
        .where(scoped(ownerId).where(preferences))
        .get();
      const { minor, unconverted } = turnover(tx, ownerId, year, row?.basis ?? "taxable");
      return LIMIT_KEYS.map((key) => {
        const limitMinor = effectiveLimit(key, row?.[key] ?? null);
        return {
          key,
          limitMinor,
          turnoverMinor: minor,
          percent: limitPercent(minor, limitMinor),
          level: limitLevel(minor, limitMinor),
          unconverted,
        };
      });
    },
    { behavior: "deferred" },
  );
}
