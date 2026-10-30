type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function serialize(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
    ]),
  );
}

function write(level: Level, msg: string, fields: Fields = {}) {
  const line = { time: new Date().toISOString(), level, msg, ...serialize(fields) };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};
