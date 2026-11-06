import Link from "next/link";
import { REPORT_TABS, reportHref, type ParsedReportFilter } from "@/lib/report-filter";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

const TAB =
  "-mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground";
const ACTIVE = "border-primary font-medium text-foreground";

// Links, not an ARIA tablist: each tab is its own URL with the filter, so it can be bookmarked.
// The tax overview is a page of its own with a year instead of a period, so it keeps no filter.
export function ReportTabs({
  filter,
  today,
  taxActive = false,
}: {
  filter: ParsedReportFilter;
  today: string;
  taxActive?: boolean;
}) {
  return (
    <nav aria-label={TEXTS.reports.tabsLabel} className="flex gap-1 overflow-x-auto border-b">
      {REPORT_TABS.map((tab) => {
        const active = !taxActive && tab === filter.tab;
        return (
          <Link
            key={tab}
            href={reportHref({ ...filter, tab }, today)}
            aria-current={active ? "page" : undefined}
            className={cn(TAB, active && ACTIVE)}
          >
            {TEXTS.reports.tabs[tab]}
          </Link>
        );
      })}
      <Link
        href="/prehledy/dane"
        aria-current={taxActive ? "page" : undefined}
        className={cn(TAB, taxActive && ACTIVE)}
      >
        {TEXTS.tax.tab}
      </Link>
    </nav>
  );
}
