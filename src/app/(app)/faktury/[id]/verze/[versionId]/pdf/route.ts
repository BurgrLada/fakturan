import { RATE_RULES } from "@/server/rate-limit";
import { versionPdf } from "@/server/services/invoice-pdf";
import { servePdf } from "@/server/services/pdf-http";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await params;
  return servePdf("inline", RATE_RULES.pdfPreviewUser, (_actor, userId) =>
    versionPdf(userId, id, versionId),
  );
}
