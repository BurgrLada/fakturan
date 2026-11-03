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

// An unwatched limit still shows the turnover, but neither a share of the limit nor a level.
export type LimitState = {
  key: LimitKey;
  limitMinor: number;
  turnoverMinor: number;
  unconverted: Unconverted;
} & ({ watched: true; percent: number; level: LimitLevel } | { watched: false });

const WATCH = { vat: "vatWatch", flat: "flatWatch" } as const;

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
          vatWatch: preferences.turnoverVatWatch,
          flatWatch: preferences.turnoverFlatWatch,
        })
        .from(preferences)
        .where(scoped(ownerId).where(preferences))
        .get();
      const { minor, unconverted } = turnover(tx, ownerId, year, row?.basis ?? "taxable");
      return LIMIT_KEYS.map((key): LimitState => {
        const limitMinor = effectiveLimit(key, row?.[key] ?? null);
        const base = { key, limitMinor, turnoverMinor: minor, unconverted };
        if (!(row?.[WATCH[key]] ?? true)) return { ...base, watched: false };
        return {
          ...base,
          watched: true,
          percent: limitPercent(minor, limitMinor),
          level: limitLevel(minor, limitMinor),
        };
      });
    },
    { behavior: "deferred" },
  );
}
