import Link from "next/link";
import { WIDGET_GALLERY, type GalleryItem } from "@/lib/dashboard-defaults";
import { MAX_WIDGETS } from "@/lib/dashboard-layout";
import { TEXTS } from "@/lib/texts";
import { isPinnedWidget } from "@/lib/widget-config";
import { widgetTitle } from "./widget-view";

const T = TEXTS.dashboard.picker;
const C = TEXTS.dashboard.configurator;

function describe(item: GalleryItem): string {
  const { config } = item;
  if (config.kind === "system") return T.system;
  return `${C.displays[config.display]} · ${C.sources[config.source]}`;
}

function Group({
  title,
  items,
  dashboardId,
  pinnedPresent,
}: {
  title: string;
  items: GalleryItem[];
  dashboardId: string;
  pinnedPresent: boolean;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-base font-medium">{title}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const name = widgetTitle(item.config);
          const taken = pinnedPresent && isPinnedWidget(item.config);
          return (
            <li key={item.id} className="flex flex-col gap-1 rounded-lg border p-3">
              {taken ? (
                <span className="font-medium">{name}</span>
              ) : (
                <Link
                  href={`/dashboardy/${dashboardId}/widget/novy?sablona=${item.id}`}
                  aria-label={T.choose(name)}
                  className="font-medium underline underline-offset-4"
                >
                  {name}
                </Link>
              )}
              <span className="text-xs text-muted-foreground">
                {taken ? T.present : describe(item)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// R-22: the 22 widgets to start from; the configurator adjusts them before anything is saved.
export function WidgetGallery({
  dashboardId,
  count,
  pinnedPresent,
}: {
  dashboardId: string;
  count: number;
  pinnedPresent: boolean;
}) {
  if (count >= MAX_WIDGETS) {
    return <p className="text-sm">{T.full(MAX_WIDGETS)}</p>;
  }
  return (
    <div className="flex flex-col gap-6" data-testid="widget-gallery">
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Group
        title={T.query}
        items={WIDGET_GALLERY.filter((item) => item.config.kind === "query")}
        dashboardId={dashboardId}
        pinnedPresent={pinnedPresent}
      />
      <Group
        title={T.system}
        items={WIDGET_GALLERY.filter((item) => item.config.kind === "system")}
        dashboardId={dashboardId}
        pinnedPresent={pinnedPresent}
      />
    </div>
  );
}
