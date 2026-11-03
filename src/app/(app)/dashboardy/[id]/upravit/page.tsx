import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DashboardEditor } from "@/components/dashboard/dashboard-editor";
import type { EditorWidget } from "@/components/dashboard/grid-editor";
import { widgetTitle } from "@/components/dashboard/widget-view";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { isPinnedWidget, type WidgetConfig } from "@/lib/widget-config";
import { requireSession } from "@/server/auth/session";
import { getDashboard, listDashboards } from "@/server/services/dashboards";
import { getPreferences } from "@/server/services/preferences";

const T = TEXTS.dashboard;
const C = T.configurator;

export const metadata: Metadata = { title: `${T.edit.title} | ${TEXTS.appName}` };

function summary(config: WidgetConfig | null): string {
  if (!config) return T.edit.broken;
  if (config.kind === "system") return T.picker.system;
  return `${C.displays[config.display]} · ${C.sources[config.source]}`;
}

async function EditContent({ params }: Pick<PageProps<"/dashboardy/[id]/upravit">, "params">) {
  const { id } = await params;
  const { user } = await requireSession();
  const dashboard = getDashboard(user.id, id);
  if (!dashboard) notFound();
  const widgets: EditorWidget[] = dashboard.widgets.map(({ id: widgetId, config, x, y, w, h }) => ({
    id: widgetId,
    x,
    y,
    w,
    h,
    title: widgetTitle(config),
    summary: summary(config),
    pinned: config !== null && isPinnedWidget(config),
  }));
  return (
    <>
      <p className="text-lg">{dashboard.name}</p>
      <DashboardEditor
        key={dashboard.id}
        dashboard={{
          id: dashboard.id,
          name: dashboard.name,
          isDefault: dashboard.isDefault,
          revision: dashboard.revision,
        }}
        count={listDashboards(user.id).length}
        widgets={widgets}
        dateFormat={getPreferences(user.id).dateFormat}
      />
    </>
  );
}

export default function EditDashboardPage({ params }: PageProps<"/dashboardy/[id]/upravit">) {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.edit.title}</h1>
      <Suspense fallback={<PageLoading />}>
        <EditContent params={params} />
      </Suspense>
    </>
  );
}
