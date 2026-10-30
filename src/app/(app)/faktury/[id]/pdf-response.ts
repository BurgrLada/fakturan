import { contentDisposition } from "@/lib/content-disposition";
import { actorFromRequest } from "@/server/auth/session";
import { RATE_RULES } from "@/server/rate-limit";
import { enforceRateLimit, RateLimitError } from "@/server/services/access";
import {
  invoicePdf,
  InvoicePdfNotFoundError,
  recordPdfDownload,
} from "@/server/services/invoice-pdf";

const empty = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function pdfResponse(id: string, type: "inline" | "attachment"): Promise<Response> {
  const actor = await actorFromRequest();
  if (!actor.userId) return empty(404);
  try {
    enforceRateLimit(actor, RATE_RULES.pdfUser);
    const { data, fileName } = await invoicePdf(actor.userId, id);
    if (type === "attachment") recordPdfDownload(actor, actor.userId, id);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(data.length),
        "Content-Disposition": contentDisposition(type, fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof InvoicePdfNotFoundError) return empty(404);
    if (error instanceof RateLimitError) return empty(429);
    throw error;
  }
}
