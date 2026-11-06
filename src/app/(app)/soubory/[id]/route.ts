import { closeSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { RateLimitError } from "@/server/services/access";
import {
  FILE_DISPOSITION,
  FileNotFoundError,
  openOwnedFile,
  statOwnedFile,
  type FileHead,
} from "@/server/services/files";

// Uploads, exports and sent archives have routes of their own; FILE_DISPOSITION says what this
// one serves and how.
const reply = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

function headersOf(opened: FileHead): HeadersInit {
  return {
    "Content-Type": opened.mimeType,
    "Content-Length": String(opened.size),
    "Content-Disposition": contentDisposition(FILE_DISPOSITION[opened.kind]!, opened.name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, no-store",
  };
}

// Without it Next answers HEAD with GET, whose stream is never read and keeps its descriptor open
// (I-1 of plan 9); a HEAD also spends no limit and writes no audit.
export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return reply(404);
  try {
    return new Response(null, { headers: headersOf(statOwnedFile(actor, id)) });
  } catch (error) {
    if (error instanceof FileNotFoundError) return reply(404);
    throw error;
  }
}

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
    return new Response(body, { headers: headersOf(opened) });
  } catch (error) {
    // Once the stream owns the descriptor, destroying it closes it.
    if (stream) stream.destroy();
    else closeSync(opened.fd);
    throw error;
  }
}
