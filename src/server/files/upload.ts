import "server-only";
import { once } from "node:events";
import { blobWriter, removeBlob } from "./store";

export class UploadTooLarge extends Error {
  constructor() {
    super("upload_too_large");
    this.name = "UploadTooLarge";
  }
}

const HEAD_BYTES = 1024;

export type StoredUpload = { size: number; head: Uint8Array };

// Counts what really arrives: a Content-Length may lie, so the cap is checked on every chunk and
// a body that crosses it leaves nothing on disk.
export async function writeCapped(
  userId: string,
  id: string,
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<StoredUpload> {
  const out = blobWriter(userId, id);
  const head = new Uint8Array(HEAD_BYTES);
  let headLength = 0;
  let size = 0;
  const reader = body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new UploadTooLarge();
      }
      if (headLength < HEAD_BYTES) {
        const piece = value.subarray(0, HEAD_BYTES - headLength);
        head.set(piece, headLength);
        headLength += piece.length;
      }
      if (!out.write(value)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (error) {
    out.destroy();
    await once(out, "close").catch(() => {});
    removeBlob(userId, id);
    throw error;
  }
  return { size, head: head.subarray(0, headLength) };
}
