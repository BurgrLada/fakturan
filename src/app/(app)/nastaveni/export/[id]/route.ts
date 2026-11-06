import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { ExportNotFoundError, openExport } from "@/server/services/exports";
import { emptyResponse } from "@/server/services/pdf-http";

// Streamed from disk: an export may be far larger than what a response should hold in memory.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return emptyResponse(404);
  let opened;
  try {
    opened = openExport(actor, id);
  } catch (error) {
    if (error instanceof ExportNotFoundError) return emptyResponse(404);
    throw error;
  }
  const body = Readable.toWeb(createReadStream(opened.path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": opened.mimeType,
      "Content-Length": String(opened.size),
      "Content-Disposition": contentDisposition("attachment", opened.fileName),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
