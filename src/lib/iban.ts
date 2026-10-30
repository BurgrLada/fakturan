const CZ_NUMERIC = "1235";

function mod97(digits: string): number {
  let rest = 0;
  for (const char of digits) rest = (rest * 10 + Number(char)) % 97;
  return rest;
}

function toNumeric(value: string): string {
  return [...value].map((char) => parseInt(char, 36)).join("");
}

export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  return mod97(toNumeric(iban.slice(4) + iban.slice(0, 4))) === 1;
}

export function czechAccountToIban(number: string, bankCode: string, prefix = ""): string {
  const [dashPrefix, dashNumber] = number.includes("-") ? number.split("-") : ["", number];
  const accountPrefix = (prefix || dashPrefix).trim();
  const accountNumber = dashNumber.trim();
  const code = bankCode.trim();
  if (!/^\d{4}$/.test(code)) throw new Error("Kód banky má mít čtyři číslice");
  if (!/^\d{0,6}$/.test(accountPrefix)) throw new Error("Předčíslí může mít nejvýše šest číslic");
  if (!/^\d{2,10}$/.test(accountNumber)) throw new Error("Číslo účtu má mít 2 až 10 číslic");
  const bban = code + accountPrefix.padStart(6, "0") + accountNumber.padStart(10, "0");
  const check = String(98 - mod97(bban + CZ_NUMERIC + "00")).padStart(2, "0");
  return `CZ${check}${bban}`;
}
