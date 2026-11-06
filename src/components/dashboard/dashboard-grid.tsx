import type { GlobalFilter } from "@/lib/dashboard-filter";
import type { CalendarDate } from "@/lib/number-format";
import type { DateFormat } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { reportWidgetFailure } from "@/server/reports/widget-failures";
import type { DashboardView } from "@/server/services/dashboards";
import { accountStamp } from "@/server/services/reports";
import { WidgetCard } from "./widget-card";

export function DashboardGrid({
  dashboard,
  filter,
  userId,
  today,
  dateFormat,
}: {
  dashboard: DashboardView;
  filter: GlobalFilter;
  userId: string;
  today: CalendarDate;
  dateFormat: DateFormat;
}) {
  const env = {
    userId,
    stamp: accountStamp(userId),
    today,
    dateFormat,
    filter,
    dashboardId: dashboard.isDefault ? null : dashboard.id,
  };
  for (const widget of dashboard.widgets) {
    if (widget.config) continue;
    reportWidgetFailure(
      widget.id,
      "dashboard.widget",
      new Error(`Neplatná konfigurace widgetu ${widget.id}`),
      userId,
    );
  }
  return (
    <div
      aria-label={TEXTS.dashboard.view.grid}
      role="region"
      data-testid="dashboard-grid"
      className="grid grid-cols-1 gap-4 md:auto-rows-[minmax(4.5rem,auto)] md:grid-cols-12"
    >
      {dashboard.widgets.map((widget) => (
        <WidgetCard key={widget.id} widget={widget} env={env} />
      ))}
    </div>
  );
}
