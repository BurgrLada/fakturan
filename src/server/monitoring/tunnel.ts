const MAX_BYTES = 1_000_000;

type Send = (url: string, init: RequestInit) => Promise<Response>;

// Only envelopes addressed to the instance's own DSN are relayed, so the route cannot be used as an open proxy.
export async function relayEnvelope(
  body: string,
  dsn: string | undefined,
  send: Send = fetch,
): Promise<Response> {
  if (!dsn) return new Response(null, { status: 404 });
  if (body.length > MAX_BYTES) return new Response(null, { status: 413 });
  let target: URL;
  try {
    target = new URL(dsn);
    const header = JSON.parse(body.slice(0, body.indexOf("\n")));
    if (header.dsn !== dsn) return new Response(null, { status: 400 });
  } catch {
    return new Response(null, { status: 400 });
  }
  const project = target.pathname.split("/").filter(Boolean).pop();
  try {
    return await send(`${target.origin}/api/${project}/envelope/`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-sentry-envelope" },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
