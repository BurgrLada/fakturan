import { Inflate } from "fflate";
import { InputRejected } from "./limits";

const CHUNK = 4 * 1024;

function isZlibHeader(data: Uint8Array): boolean {
  const cmf = data[0];
  const flg = data[1];
  if (cmf === undefined || flg === undefined) return false;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}

// Output is checked after every 4 KiB of input, so the overrun past maxBytes stays near 4 MiB.
export function boundedInflate(data: Uint8Array, maxBytes: number): Uint8Array {
  const body = isZlibHeader(data) ? data.subarray(2) : data;
  const parts: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inflater = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total <= maxBytes) parts.push(chunk);
    if (final) done = true;
  });
  try {
    for (let offset = 0; offset < body.length && !done; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, body.length);
      inflater.push(body.subarray(offset, end), end === body.length);
      if (total > maxBytes) throw new InputRejected("inflate_too_large");
    }
    if (!done) inflater.push(new Uint8Array(0), true);
  } catch (error) {
    if (error instanceof InputRejected) throw error;
    throw new InputRejected("inflate_corrupt", undefined, String(error));
  }
  if (total > maxBytes) throw new InputRejected("inflate_too_large");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
