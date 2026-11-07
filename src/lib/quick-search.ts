import { foldText } from "@/lib/fold-text";
import { isVisible, NAV_ROUTES, SETTINGS_TABS } from "@/lib/nav";
import { TEXTS } from "@/lib/texts";

export const SEARCH_GROUPS = ["invoice", "customer", "catalog", "recurring", "page"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export type SearchHit = {
  group: SearchGroup;
  id: string;
  label: string;
  detail: string;
  href: string;
};

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;
export const PER_GROUP = 5;
export const SEARCH_DELAY_MS = 150;

const T = TEXTS.quickSearch;

export function staticHits(q: string, role: string | null): SearchHit[] {
  const term = foldText(q.trim());
  if (term.length < MIN_QUERY_LENGTH) return [];
  const pages: SearchHit[] = [
    ...NAV_ROUTES.filter((item) => isVisible(item, role)).map((item) => ({
      group: "page" as const,
      id: `nav:${item.key}`,
      label: item.label,
      detail: T.section,
      href: item.href,
    })),
    ...SETTINGS_TABS.map((tab) => ({
      group: "page" as const,
      id: `settings:${tab.href}`,
      label: tab.label,
      detail: T.settings,
      href: tab.href,
    })),
  ];
  return pages.filter((hit) => foldText(hit.label).includes(term)).slice(0, PER_GROUP);
}
