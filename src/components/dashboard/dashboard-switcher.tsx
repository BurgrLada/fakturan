import Link from "next/link";
import { dashboardHref, type GlobalFilter } from "@/lib/dashboard-filter";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";
import type { DashboardSummary } from "@/server/services/dashboards";

// Links, not state: switching keeps the filter and works without JavaScript.
export function DashboardSwitcher({
  dashboards,
  currentId,
  filter,
}: {
  dashboards: DashboardSummary[];
  currentId: string;
  filter: GlobalFilter;
}) {
  return (
    <nav aria-label={TEXTS.dashboard.view.switcher}>
      <ul className="flex flex-wrap gap-2">
        {dashboards.map((item) => {
          const current = item.id === currentId;
          return (
            <li key={item.id}>
              <Link
                href={dashboardHref(item.isDefault ? null : item.id, filter)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex rounded-md border px-3 py-1 text-sm",
                  current ? "bg-accent font-medium text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                {item.name}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
