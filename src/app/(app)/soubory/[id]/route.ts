import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { FileNotFoundError, readOwnedFile } from "@/server/services/files";

// Only the account's own images: imports, exports and archives carry personal data and each gets
// a route of its own with an attachment download.
const INLINE_KINDS: readonly string[] = ["logo", "qr_logo", "signature"];

const notFound = () =>
  new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return notFound();
  try {
    const { data, mimeType, name, kind } = readOwnedFile(actor, id);
    if (!INLINE_KINDS.includes(kind)) return notFound();
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
