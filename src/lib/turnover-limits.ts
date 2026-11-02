export const VAT_REGISTRATION_LIMIT_MINOR = 200_000_000;
export const FLAT_TAX_LIMIT_MINOR = 200_000_000;

export const LIMIT_WARN_PERCENT = 80;
export const LIMIT_HIGH_PERCENT = 95;

export const LIMIT_KEYS = ["vat", "flat"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_LEVELS = ["ok", "warn", "high", "over"] as const;
export type LimitLevel = (typeof LIMIT_LEVELS)[number];

export const STATUTORY_LIMITS: Record<LimitKey, number> = {
  vat: VAT_REGISTRATION_LIMIT_MINOR,
  flat: FLAT_TAX_LIMIT_MINOR,
};

// A stored value overrides the statutory one; null means the account never changed it.
export function effectiveLimit(key: LimitKey, custom: number | null): number {
  return custom ?? STATUTORY_LIMITS[key];
}

// The thresholds are compared without division: turnover * 100 >= limit * threshold.
export function limitLevel(turnoverMinor: number, limitMinor: number): LimitLevel {
  const scaled = BigInt(turnoverMinor) * BigInt(100);
  const limit = BigInt(limitMinor);
  if (scaled > limit * BigInt(100)) return "over";
  if (scaled >= limit * BigInt(LIMIT_HIGH_PERCENT)) return "high";
  if (scaled >= limit * BigInt(LIMIT_WARN_PERCENT)) return "warn";
  return "ok";
}

// Whole percent, rounded down, so 99,99 % never reads as 100 %. A negative turnover is 0.
export function limitPercent(turnoverMinor: number, limitMinor: number): number {
  if (turnoverMinor <= 0) return 0;
  return Number((BigInt(turnoverMinor) * BigInt(100)) / BigInt(limitMinor));
}
