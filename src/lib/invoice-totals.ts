import { AmountOutOfRangeError } from "./money";

export type Discount =
  | { kind: "none" }
  | { kind: "percent"; basisPoints: number }
  | { kind: "amount"; minor: number };

export type TotalsLine = { quantityMilli: number; unitPriceMinor: number; discount: Discount };

export type RoundingMode = "none" | "whole";

export type Totals = {
  lines: { grossMinor: number; discountMinor: number; netMinor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  roundingMinor: number;
  totalMinor: number;
};

export const MAX_DOCUMENT_MINOR = 99_999_999_999;
export const MAX_QUANTITY_MILLI = 9_999_999_999;

const MAX_DOCUMENT = BigInt(MAX_DOCUMENT_MINOR);
const MAX_QUANTITY = BigInt(MAX_QUANTITY_MILLI);
const ZERO = BigInt(0);
const TWO = BigInt(2);
const BASIS_POINTS = BigInt(10_000);
const MILLI = BigInt(1000);
const HUNDRED = BigInt(100);

function nonNegativeInteger(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new AmountOutOfRangeError();
  return BigInt(value);
}

function withinDocument(value: bigint): bigint {
  if (value > MAX_DOCUMENT) throw new AmountOutOfRangeError();
  return value;
}

// Only ever called with non-negative numerators, so floor of (2n + d) / 2d is half away from zero.
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (TWO * numerator + denominator) / (TWO * denominator);
}

function discountOf(base: bigint, discount: Discount): bigint {
  let raw = ZERO;
  if (discount.kind === "percent") {
    raw = divideRounded(base * nonNegativeInteger(discount.basisPoints), BASIS_POINTS);
  } else if (discount.kind === "amount") {
    raw = nonNegativeInteger(discount.minor);
  }
  return raw < base ? raw : base;
}

export function computeTotals(
  lines: TotalsLine[],
  discount: Discount,
  rounding: RoundingMode,
): Totals {
  let subtotal = ZERO;
  const computed = lines.map((line) => {
    const quantity = nonNegativeInteger(line.quantityMilli);
    if (quantity > MAX_QUANTITY) throw new AmountOutOfRangeError();
    const gross = withinDocument(
      divideRounded(quantity * nonNegativeInteger(line.unitPriceMinor), MILLI),
    );
    const lineDiscount = discountOf(gross, line.discount);
    const net = gross - lineDiscount;
    subtotal = withinDocument(subtotal + net);
    return {
      grossMinor: Number(gross),
      discountMinor: Number(lineDiscount),
      netMinor: Number(net),
    };
  });

  const documentDiscount = discountOf(subtotal, discount);
  const discounted = subtotal - documentDiscount;
  const total = rounding === "whole" ? divideRounded(discounted, HUNDRED) * HUNDRED : discounted;
  withinDocument(total);

  return {
    lines: computed,
    subtotalMinor: Number(subtotal),
    discountMinor: Number(documentDiscount),
    roundingMinor: Number(total - discounted),
    totalMinor: Number(total),
  };
}

const QUANTITY = /^(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,3}))?$/;

export function parseQuantity(input: string): number | null {
  const match = QUANTITY.exec(input.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const milli = Number(whole!.replace(/[   ]/g, "")) * 1000 + Number(fraction.padEnd(3, "0"));
  return milli <= MAX_QUANTITY_MILLI ? milli : null;
}

export function formatQuantity(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const fraction = String(milli % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole},${fraction}` : String(whole);
}
