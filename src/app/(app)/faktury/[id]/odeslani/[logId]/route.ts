import { RATE_RULES } from "@/server/rate-limit";
import { archivedPdf } from "@/server/services/invoice-mail";
import { servePdf } from "@/server/services/pdf-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; logId: string }> },
) {
  const { logId } = await params;
  return servePdf("attachment", RATE_RULES.pdfUser, async (actor) => archivedPdf(actor, logId));
}
