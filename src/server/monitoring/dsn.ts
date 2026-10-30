// The public part of a DSN. A legacy secret key (the password part) is never needed by senders.
export type ParsedDsn = { origin: string; prefix: string; key: string; project: string };

export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const parts = url.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!project || !url.username) return null;
    return {
      origin: url.origin,
      prefix: parts.length ? `/${parts.join("/")}` : "",
      key: decodeURIComponent(url.username),
      project,
    };
  } catch {
    return null;
  }
}

export function publicDsn(dsn: string): string | null {
  const p = parseDsn(dsn);
  if (!p) return null;
  const url = new URL(p.origin);
  return `${url.protocol}//${p.key}@${url.host}${p.prefix}/${p.project}`;
}

export function sameDsn(a: string, b: string): boolean {
  const x = parseDsn(a);
  const y = parseDsn(b);
  return Boolean(
    x &&
    y &&
    x.origin === y.origin &&
    x.prefix === y.prefix &&
    x.key === y.key &&
    x.project === y.project,
  );
}
