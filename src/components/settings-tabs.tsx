"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/nastaveni/ucet", label: TEXTS.settings.account },
  { href: "/nastaveni/dodavatel", label: TEXTS.settings.supplier },
  { href: "/nastaveni/ucty", label: TEXTS.settings.bankAccounts },
  { href: "/nastaveni/rady", label: TEXTS.settings.numberSeries },
  { href: "/nastaveni/vychozi", label: TEXTS.settings.defaults },
  { href: "/nastaveni/designy", label: TEXTS.settings.designs },
  { href: "/nastaveni/automatizace", label: TEXTS.settings.automation },
  { href: "/nastaveni/historie", label: TEXTS.settings.history },
];

export function SettingsTabs() {
  return <SettingsTabsView pathname={usePathname()} />;
}

export function SettingsTabsView({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label={TEXTS.settings.nav} className="flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
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
