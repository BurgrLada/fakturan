import { closeSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { RateLimitError } from "@/server/services/access";
import { FILE_DISPOSITION, FileNotFoundError, openOwnedFile } from "@/server/services/files";

// Uploads, exports and sent archives have routes of their own; FILE_DISPOSITION says what this
// one serves and how.
const reply = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return reply(404);
  let opened;
  try {
    opened = openOwnedFile(actor, id);
  } catch (error) {
    if (error instanceof FileNotFoundError) return reply(404);
    if (error instanceof RateLimitError) return reply(429);
    throw error;
  }
  let stream: ReturnType<typeof createReadStream> | null = null;
  try {
    stream = createReadStream("", { fd: opened.fd, autoClose: true });
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": opened.mimeType,
        "Content-Length": String(opened.size),
        "Content-Disposition": contentDisposition(FILE_DISPOSITION[opened.kind]!, opened.name),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    // Once the stream owns the descriptor, destroying it closes it.
    if (stream) stream.destroy();
    else closeSync(opened.fd);
    throw error;
  }
}
