import type { NextRequest } from "next/server";
import { exportWidget } from "@/server/services/dashboards";
import { dashboardFileResponse } from "../../../../export-response";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/dashboardy/[id]/widget/[widgetId]/export">,
) {
  const { id, widgetId } = await ctx.params;
  return dashboardFileResponse(request, "fakturan-widget.json", (actor) =>
    exportWidget(actor, id, widgetId),
  );
}
