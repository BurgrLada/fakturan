export function isValidIco(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 7).reduce((acc, digit, i) => acc + digit * (8 - i), 0);
  return digits[7] === (11 - (sum % 11)) % 10;
}
