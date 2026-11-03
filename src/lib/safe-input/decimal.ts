import { InputRejected } from "./limits";

const DECIMAL = /^([+-]?)(\d*)(?:[.,](\d*))?$/;
const ONE = BigInt(1);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

// Amounts from foreign files never pass through Number or parseFloat.
export function decimalToMinor(text: string, scale: number): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12)
    throw new RangeError(`Neplatné měřítko: ${scale}`);
  const match = DECIMAL.exec(text.trim());
  const whole = match?.[2] ?? "";
  const fraction = match?.[3] ?? "";
  if (!match || whole.length + fraction.length === 0) {
    throw new InputRejected("decimal_invalid", undefined, text.slice(0, 40));
  }
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  let magnitude = BigInt((whole || "0") + kept);
  // Half away from zero: only the first dropped digit decides, the sign is applied afterwards.
  if ((fraction[scale] ?? "0") >= "5") magnitude += ONE;
  if (magnitude > MAX) throw new InputRejected("decimal_overflow", undefined, text.slice(0, 40));
  const value = Number(magnitude);
  return match[1] === "-" && value !== 0 ? -value : value;
}

export function decimalToMicros(text: string): number {
  return decimalToMinor(text, 6);
}

export function quantityToMilli(text: string): number {
  return decimalToMinor(text, 3);
}
