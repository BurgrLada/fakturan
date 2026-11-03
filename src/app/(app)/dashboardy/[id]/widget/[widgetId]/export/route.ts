import type { NextRequest } from "next/server";
import { exportWidget } from "@/server/services/dashboards";
import { dashboardFileResponse } from "../../../../export-response";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/dashboardy/[id]/widget/[widgetId]/export">,
) {
  const { id, widgetId } = await ctx.params;
  return dashboardFileResponse(request, "fakturan-widget.json", (ownerId) =>
    exportWidget(ownerId, id, widgetId),
  );
}
