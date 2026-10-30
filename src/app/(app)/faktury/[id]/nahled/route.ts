import { pdfResponse } from "../pdf-response";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return pdfResponse(id, "inline");
}
