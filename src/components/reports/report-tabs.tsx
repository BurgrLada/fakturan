import Link from "next/link";
import { REPORT_TABS, reportHref, type ParsedReportFilter } from "@/lib/report-filter";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

// Links, not an ARIA tablist: each tab is its own URL with the filter, so it can be bookmarked.
export function ReportTabs({ filter, today }: { filter: ParsedReportFilter; today: string }) {
  return (
    <nav aria-label={TEXTS.reports.tabsLabel} className="flex gap-1 overflow-x-auto border-b">
      {REPORT_TABS.map((tab) => {
        const active = tab === filter.tab;
        return (
          <Link
            key={tab}
            href={reportHref({ ...filter, tab }, today)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
              active && "border-primary font-medium text-foreground",
            )}
          >
            {TEXTS.reports.tabs[tab]}
          </Link>
        );
      })}
    </nav>
  );
}
