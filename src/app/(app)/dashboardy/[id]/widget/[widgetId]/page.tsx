import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WidgetConfigurator } from "@/components/dashboard/widget-configurator";
import { WidgetGallery } from "@/components/dashboard/widget-gallery";
import { PageLoading } from "@/components/page-loading";
import { WIDGET_GALLERY } from "@/lib/dashboard-defaults";
import { TEXTS } from "@/lib/texts";
import { isPinnedWidget } from "@/lib/widget-config";
import { requireSession } from "@/server/auth/session";
import { getDashboard } from "@/server/services/dashboards";
import { getPreferences } from "@/server/services/preferences";

const T = TEXTS.dashboard;
const C = T.configurator;

export const metadata: Metadata = { title: `${C.titleEdit} | ${TEXTS.appName}` };

const NEW = "novy";
// A widget whose stored config no longer parses starts over from the first gallery widget.
const FALLBACK = WIDGET_GALLERY[0]!.config;

type Props = PageProps<"/dashboardy/[id]/widget/[widgetId]">;

async function WidgetContent({ params, searchParams }: Pick<Props, "params" | "searchParams">) {
  const { id, widgetId } = await params;
  const { sablona } = await searchParams;
  const { user } = await requireSession();
  const dashboard = getDashboard(user.id, id);
  if (!dashboard) notFound();
  const back = (
    <Link href={`/dashboardy/${id}/upravit`} className="text-sm underline underline-offset-4">
      {C.back}
    </Link>
  );
  const dateFormat = getPreferences(user.id).dateFormat;

  if (widgetId === NEW) {
    const template = WIDGET_GALLERY.find((item) => item.id === sablona);
    if (!template) {
      return (
        <>
          <h2 className="text-lg">{T.picker.title}</h2>
          {back}
          <WidgetGallery
            dashboardId={id}
            count={dashboard.widgets.length}
            pinnedPresent={dashboard.widgets.some((w) => w.config && isPinnedWidget(w.config))}
          />
        </>
      );
    }
    return (
      <>
        <h2 className="text-lg">{C.titleNew}</h2>
        {back}
        <WidgetConfigurator
          dashboardId={id}
          widgetId={null}
          initial={template.config}
          dateFormat={dateFormat}
        />
      </>
    );
  }

  const widget = dashboard.widgets.find((item) => item.id === widgetId);
  if (!widget) notFound();
  return (
    <>
      <h2 className="text-lg">{C.titleEdit}</h2>
      {back}
      <WidgetConfigurator
        dashboardId={id}
        widgetId={widget.id}
        initial={widget.config ?? FALLBACK}
        dateFormat={dateFormat}
      />
    </>
  );
}

export default function WidgetPage({ params, searchParams }: Props) {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.edit.title}</h1>
      <Suspense fallback={<PageLoading />}>
        <WidgetContent params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}
