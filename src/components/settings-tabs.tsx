"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/nastaveni/ucet", label: TEXTS.settings.account },
  { href: "/nastaveni/dodavatel", label: TEXTS.settings.supplier },
  { href: "/nastaveni/ucty", label: TEXTS.settings.bankAccounts },
  { href: "/nastaveni/historie", label: TEXTS.settings.history },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label={TEXTS.settings.nav} className="flex gap-1 border-b">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
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
