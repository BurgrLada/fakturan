const VISIBLE_DIGITS = 4;

// The bank code stays readable, it identifies the bank and not the holder.
export function maskAccount(value: string): string {
  const [number, ...bankCode] = value.split("/");
  let visible = VISIBLE_DIGITS;
  const masked = [...number!].reverse().map((char) => {
    if (!/\d/.test(char) || visible === 0) return /\d/.test(char) ? "*" : char;
    visible -= 1;
    return char;
  });
  return [masked.reverse().join(""), ...bankCode].join("/");
}

// IBAN in groups, Czech account with a bank code, then any long run. A shorter account
// or an IBAN split by spaces has no run long enough for the last alternative alone.
const SENSITIVE =
  /\b[A-Z]{2}\d{2}(?:[ \u00A0]?[A-Z\d]{4})+(?:[ \u00A0]?[A-Z\d]{1,3})?\b|(?:\d{1,6}-)?\d{1,10}\/\d{4}\b|\d{7,}/g;

export function maskDigits(text: string): string {
  return text.replace(SENSITIVE, maskAccount);
}
