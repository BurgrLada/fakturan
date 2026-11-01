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

// IBAN in groups in any letter case, Czech account with a bank code, a prefix without one, then any
// long run. A date cannot pass for a prefix: the part after the hyphen needs five digits. A word
// caught as an IBAN group stays as it was, masking only touches digits.
const SEP = "[ \\t\\u00A0\\u202F.\\-]";
const SENSITIVE = new RegExp(
  [
    `\\b[A-Za-z]{2}\\d{2}(?:${SEP}?[A-Za-z\\d]{4}){1,8}(?:${SEP}?[A-Za-z\\d]{1,3})?\\b`,
    "(?:\\d{1,6}-)?\\d{1,10}\\/\\d{4}\\b",
    "\\b\\d{1,6}-\\d{5,10}\\b",
    "\\d{7,}",
  ].join("|"),
  "g",
);

export function maskDigits(text: string): string {
  return text.replace(SENSITIVE, maskAccount);
}
