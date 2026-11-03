import type { NextRequest } from "next/server";
import { exportDashboard } from "@/server/services/dashboards";
import { dashboardFileResponse } from "../../export-response";

export async function POST(request: NextRequest, ctx: RouteContext<"/dashboardy/[id]/export">) {
  const { id } = await ctx.params;
  return dashboardFileResponse(request, "fakturan-dashboard.json", (actor) =>
    exportDashboard(actor, id),
  );
}
