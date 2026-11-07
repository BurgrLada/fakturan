import { Inflate } from "fflate";
import { InputRejected } from "./limits";

const CHUNK = 4 * 1024;

function isZlibHeader(data: Uint8Array): boolean {
  // A missing byte reads as 0: no CMF with method 8 and window <= 7 has (CMF << 8) % 31 === 0.
  const cmf = data[0] ?? 0;
  const flg = data[1] ?? 0;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0 && (flg & 0x20) === 0;
}

// Input goes in 4 KiB blocks and fflate hands over one block's output at a time, so the output held
// past maxBytes stays near what a single block can inflate to.
export function boundedInflate(data: Uint8Array, maxBytes: number): Uint8Array {
  const body = isZlibHeader(data) ? data.subarray(2) : data;
  const parts: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new InputRejected("inflate_too_large");
    parts.push(chunk);
  });
  try {
    // The last block goes in as final, so fflate either finishes or throws; empty input stays empty.
    for (let offset = 0; offset < body.length; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, body.length);
      inflater.push(body.subarray(offset, end), end === body.length);
    }
  } catch (error) {
    if (error instanceof InputRejected) throw error;
    throw new InputRejected("inflate_corrupt", undefined, String(error));
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
