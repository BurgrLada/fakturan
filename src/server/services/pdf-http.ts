import "server-only";
import * as Sentry from "@sentry/nextjs";
import { contentDisposition } from "@/lib/content-disposition";
import { TEXTS } from "@/lib/texts";
import type { Actor } from "../audit/context";
import { actorFromRequest } from "../auth/session";
import type { RateRule } from "../rate-limit";
import { enforceRateLimit, PdfTooLong, RateLimitError } from "./access";
import { InvoicePdfNotFoundError } from "./invoice-pdf";

type Disposition = "inline" | "attachment";

export class InvalidPreviewQuery extends Error {}

export const emptyResponse = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

// An iframe cannot report a status to its page, so a preview failure has to be readable inside it.
export function messageResponse(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html lang="cs"><meta charset="utf-8"><body style="font:16px system-ui;margin:2rem">${message}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    },
  );
}

function pdfBody(data: Buffer, type: Disposition, fileName: string): Response {
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(data.length),
      "Content-Disposition": contentDisposition(type, fileName),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function servePdf(
  type: Disposition,
  rule: RateRule,
  run: (actor: Actor, userId: string) => Promise<{ data: Buffer; fileName: string }>,
): Promise<Response> {
  const actor = await actorFromRequest();
  const { userId } = actor;
  if (!userId) return emptyResponse(404);
  try {
    enforceRateLimit(actor, rule);
    const { data, fileName } = await run(actor, userId);
    return pdfBody(data, type, fileName);
  } catch (error) {
    if (error instanceof InvoicePdfNotFoundError) return emptyResponse(404);
    if (error instanceof PdfTooLong) return messageResponse(422, error.message);
    if (error instanceof InvalidPreviewQuery) return messageResponse(400, TEXTS.pdf.previewFailed);
    if (error instanceof RateLimitError) {
      return type === "inline" ? messageResponse(429, TEXTS.pdf.previewBusy) : emptyResponse(429);
    }
    if (type === "attachment") throw error;
    Sentry.captureException(error);
    return messageResponse(500, TEXTS.pdf.previewFailed);
  }
}
