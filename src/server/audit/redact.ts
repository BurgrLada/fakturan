const MASK = "[skryto]";
const SENSITIVE = ["password", "secret", "token", "apikey", "privatekey"];

function isSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE.some((part) => normalized.includes(part));
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSensitive(key) ? MASK : redact(item)]),
  );
}
