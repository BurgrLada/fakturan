import type { GlobalFilter } from "@/lib/dashboard-filter";
import { dashboardHref, widgetQuery } from "@/lib/dashboard-filter";
import type { CalendarDate } from "@/lib/number-format";
import type { DateFormat } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import type { WidgetConfig } from "@/lib/widget-config";
import { cachedWidget } from "@/server/report-cache";
import {
  widgetProblem,
  type WidgetContext,
  type WidgetResult,
} from "@/server/reports/widget-query";
import { reportFailure } from "@/server/scheduler/report";
import { ServiceError } from "@/server/services/access";
import { widgetResult } from "@/server/services/widgets";
import { WidgetEmpty } from "./widget-empty";
import { WidgetErrorMessage } from "./widget-error";
import { widgetUnit } from "./widget-number";
import { WidgetView } from "./widget-view";

const T = TEXTS.dashboard;
const V = T.view;

export type WidgetEnv = {
  userId: string;
  stamp: string;
  today: CalendarDate;
  dateFormat: DateFormat;
  filter: GlobalFilter;
  // null for the default dashboard, whose address is plain "/".
  dashboardId: string | null;
};

// Only paid_ratio of the system widgets has a period; the rest ignore the dashboard filter (R-21).
function effectiveFilter(config: WidgetConfig, filter: GlobalFilter): GlobalFilter {
  if (config.kind === "query" || config.systemId === "paid_ratio") return filter;
  return {};
}

// Live widgets read on every request: the due alerts card must match the notification centre,
// which is computed per read as well (R-20).
const LIVE = new Set(["due_alerts"]);

async function load(config: WidgetConfig, env: WidgetEnv): Promise<WidgetResult> {
  const filter = effectiveFilter(config, env.filter);
  if (config.kind === "system" && LIVE.has(config.systemId)) {
    return widgetResult(env.userId, config, { today: env.today, globalFilter: filter });
  }
  return cachedWidget(env.userId, env.stamp, env.today, widgetQuery(config, filter));
}

export async function WidgetBody({
  config,
  title,
  h,
  env,
}: {
  config: WidgetConfig;
  title: string;
  h: number;
  env: WidgetEnv;
}) {
  const filter = effectiveFilter(config, env.filter);
  const context: WidgetContext = { today: env.today, globalFilter: filter };
  const unit = widgetUnit(config, filter);
  // Only a set filter can be the cause, so only then is resetting it the next step.
  const reset =
    Object.keys(filter).length > 0
      ? { href: dashboardHref(env.dashboardId, {}), label: T.filter.reset }
      : undefined;
  if (config.kind === "query") {
    const own = config.filters?.currency;
    if (own && filter.currency && own !== filter.currency) {
      return <WidgetEmpty text={V.excluded} action={reset} />;
    }
  }
  const problem = widgetProblem(config, context);
  if (problem) return <WidgetEmpty text={problem} action={reset} />;

  let result: WidgetResult;
  try {
    result = await load(config, env);
  } catch (error) {
    if (error instanceof ServiceError) {
      return <WidgetEmpty text={error.message} action={reset} />;
    }
    reportFailure(error, { task: "dashboard.widget", userId: env.userId });
    return <WidgetErrorMessage />;
  }

  return (
    <WidgetView
      config={config}
      result={result}
      unit={unit}
      title={title}
      h={h}
      dateFormat={env.dateFormat}
      mode={filter.compare}
    />
  );
}
