import { parseDsn, sameDsn } from "./dsn";

export const MAX_ENVELOPE_BYTES = 1_000_000;
const SEND_TIMEOUT_MS = 5000;

type Send = (url: string, init: RequestInit) => Promise<Response>;

export class TooLarge extends Error {}

// Aborts as soon as the cap is crossed, so an oversize body is never buffered whole.
export async function readCapped(request: Request, max = MAX_ENVELOPE_BYTES): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Only envelopes addressed to the instance's own DSN are relayed, so the route cannot be used as an open proxy.
export async function relayEnvelope(
  body: Uint8Array,
  dsn: string | undefined,
  send: Send = fetch,
): Promise<Response> {
  const target = dsn ? parseDsn(dsn) : null;
  if (!dsn || !target) return new Response(null, { status: 404 });
  if (body.byteLength > MAX_ENVELOPE_BYTES) return new Response(null, { status: 413 });
  const end = body.indexOf(10);
  try {
    const header = JSON.parse(
      new TextDecoder().decode(body.subarray(0, end < 0 ? undefined : end)),
    );
    if (typeof header.dsn !== "string" || !sameDsn(header.dsn, dsn)) {
      return new Response(null, { status: 400 });
    }
  } catch {
    return new Response(null, { status: 400 });
  }
  try {
    return await send(`${target.origin}${target.prefix}/api/${target.project}/envelope/`, {
      method: "POST",
      body: body as BodyInit,
      headers: { "Content-Type": "application/x-sentry-envelope" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
