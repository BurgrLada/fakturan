const VISIBLE_DIGITS = 4;

export function maskDigits(text: string): string {
  return text.replace(/\d{7,}/g, (run) => run.slice(-VISIBLE_DIGITS).padStart(run.length, "*"));
}

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
