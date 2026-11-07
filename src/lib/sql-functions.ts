import type Database from "better-sqlite3";
import { czechSortKey } from "./czech-sort";
import { foldText } from "./fold-text";
import { toCzkMinor } from "./fx";
import { calendarDateInPrague } from "./number-format";
import { bucketKey, type BucketUnit } from "./report-period";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

// An exception inside a function aborts the whole statement, so bad input yields NULL instead.
function nullOnError<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

// BigInt makes SQLite store an INTEGER: a plain number may come back as REAL and drift in a sum.
export function fxCzk(currency: unknown, amount: unknown, rate: unknown): bigint | null {
  if (typeof currency !== "string" || !Number.isSafeInteger(amount)) return null;
  if (currency === "CZK") return BigInt(amount as number);
  if (typeof rate !== "number") return null;
  return nullOnError(() => BigInt(toCzkMinor(amount as number, rate)));
}

// Half away from zero, like every other rounding of money.
export function medianMinor(values: number[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return BigInt(sorted[middle]!);
  const sum = BigInt(sorted[middle - 1]!) + BigInt(sorted[middle]!);
  const half = ((sum < ZERO ? -sum : sum) + ONE) / TWO;
  return sum < ZERO ? -half : half;
}

export function registerSqlFunctions(sqlite: Database.Database): void {
  sqlite.function("czech_key", { deterministic: true }, (text) =>
    typeof text === "string" ? czechSortKey(text) : null,
  );
  sqlite.function("fold_text", { deterministic: true }, (text) =>
    typeof text === "string" ? foldText(text) : null,
  );
  sqlite.function("fx_czk", { deterministic: true }, fxCzk);
  sqlite.function("date_bucket", { deterministic: true }, (date, unit) =>
    typeof date === "string" ? nullOnError(() => bucketKey(date, unit as BucketUnit)) : null,
  );
  sqlite.function("prague_date", { deterministic: true }, (ms) =>
    typeof ms === "number" ? nullOnError(() => calendarDateInPrague(new Date(ms))) : null,
  );
  sqlite.aggregate("median_minor", {
    start: () => [] as number[],
    step: (values: number[], value: unknown) => {
      if (Number.isSafeInteger(value)) values.push(value as number);
      return values;
    },
    result: (values: number[]) => medianMinor(values),
  });
}
