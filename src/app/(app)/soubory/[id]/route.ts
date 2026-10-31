import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { FileNotFoundError, readOwnedFile } from "@/server/services/files";

const notFound = () =>
  new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return notFound();
  try {
    const { data, mimeType, name, kind } = readOwnedFile(actor, id);
    // The archive has its own route with a rate limit and an audit row.
    if (kind === "sent_pdf") return notFound();
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(data.length),
        "Content-Disposition": contentDisposition("inline", name),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof FileNotFoundError) return notFound();
    throw error;
  }
}
