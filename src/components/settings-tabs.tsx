"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS } from "@/lib/nav";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

export function SettingsTabs() {
  return <SettingsTabsView pathname={usePathname()} />;
}

export function SettingsTabsView({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label={TEXTS.settings.nav} className="flex gap-1 overflow-x-auto border-b">
      {SETTINGS_TABS.map((tab) => {
        const active = pathname !== null && pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
              active && "border-primary font-medium text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
