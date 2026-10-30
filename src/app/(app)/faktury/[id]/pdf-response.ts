import { RATE_RULES } from "@/server/rate-limit";
import { invoicePdf, recordPdfDownload } from "@/server/services/invoice-pdf";
import { servePdf } from "@/server/services/pdf-http";

export function pdfResponse(id: string, type: "inline" | "attachment"): Promise<Response> {
  const rule = type === "inline" ? RATE_RULES.pdfPreviewUser : RATE_RULES.pdfUser;
  return servePdf(type, rule, async (actor, userId) => {
    const pdf = await invoicePdf(userId, id);
    if (type === "attachment") recordPdfDownload(actor, userId, id);
    return pdf;
  });
}
