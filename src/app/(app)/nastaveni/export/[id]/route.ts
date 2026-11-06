import { closeSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { RateLimitError } from "@/server/services/access";
import { ExportNotFoundError, openExport } from "@/server/services/exports";
import { emptyResponse } from "@/server/services/pdf-http";

// Streamed from the descriptor openExport opened: an export may be far larger than what a response
// should hold in memory, and the file may be cleaned up while it is sent.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return emptyResponse(404);
  let opened;
  try {
    opened = openExport(actor, id);
  } catch (error) {
    if (error instanceof ExportNotFoundError) return emptyResponse(404);
    if (error instanceof RateLimitError) return emptyResponse(429);
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
        "Content-Disposition": contentDisposition("attachment", opened.fileName),
        "X-Content-Type-Options": "nosniff",
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
