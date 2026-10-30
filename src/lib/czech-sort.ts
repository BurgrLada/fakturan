const ALPHABET = [
  "a",
  "b",
  "c",
  "č",
  "d",
  "e",
  "f",
  "g",
  "h",
  "ch",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "ř",
  "s",
  "š",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "ž",
];
const WEIGHT_BASE = 0x1000;
const WEIGHTS = new Map(ALPHABET.map((letter, index) => [letter, WEIGHT_BASE + index]));

function weightOf(char: string): number | undefined {
  const direct = WEIGHTS.get(char);
  if (direct !== undefined) return direct;
  const base = char.normalize("NFD").replace(/\p{M}/gu, "");
  return WEIGHTS.get(base);
}

// Binary order of the key follows Czech alphabetical order (Č after C, CH after H), so SQLite can
// sort by it without ICU. The original text breaks ties, which keeps the order deterministic.
export function czechSortKey(text: string): string {
  const lower = text.normalize("NFC").toLowerCase();
  let key = "";
  for (let i = 0; i < lower.length; i += 1) {
    if (lower.startsWith("ch", i)) {
      key += String.fromCharCode(WEIGHTS.get("ch")!);
      i += 1;
      continue;
    }
    const char = lower[i]!;
    const weight = weightOf(char);
    key += weight === undefined ? char : String.fromCharCode(weight);
  }
  return `${key}\u0000${text}`;
}
