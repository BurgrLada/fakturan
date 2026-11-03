import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { FileNotFoundError, readOwnedFile } from "@/server/services/files";

// The account's images render inline. An imported PDF is someone else's document and only ever
// downloads; uploads, exports and archives have routes of their own with audit.
const DISPOSITION: Partial<Record<string, "inline" | "attachment">> = {
  logo: "inline",
  qr_logo: "inline",
  signature: "inline",
  import_pdf: "attachment",
};

const notFound = () =>
  new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await actorFromRequest();
  if (!actor.userId) return notFound();
  try {
    const { data, mimeType, name, kind } = readOwnedFile(actor, id);
    const disposition = DISPOSITION[kind];
    if (!disposition) return notFound();
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(data.length),
        "Content-Disposition": contentDisposition(disposition, name),
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
