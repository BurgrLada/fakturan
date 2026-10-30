const MASK = "[skryto]";
const BINARY = "[binární data]";
const SENSITIVE = [
  "pass",
  "pwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "cookie",
  "authorization",
  "heslo",
  "totp",
];

function isSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE.some((part) => normalized.includes(part));
}

function redactEntries(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(
    Array.from(entries, ([key, item]) => [key, isSensitive(key) ? MASK : redact(item)]),
  );
}

function hasToJson(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

export function redact(value: unknown): unknown {
  // A function kept in the output would be invoked by JSON.stringify if it were named toJSON.
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return BINARY;
  if (hasToJson(value)) return redact(value.toJSON());
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Map) {
    return redactEntries(Array.from(value, ([key, item]) => [String(key), item]));
  }
  if (value instanceof Set) return Array.from(value, redact);
  return redactEntries(Object.entries(value));
}
