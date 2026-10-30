"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, NAV_ITEMS, type NavKey } from "@/components/nav";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

export function NavLinks({ keys }: { keys: NavKey[] }) {
  return <NavLinksView keys={keys} pathname={usePathname()} />;
}

// Without a pathname nothing is marked active: the Suspense fallback cannot read the URL.
export function NavLinksView({ keys, pathname }: { keys: NavKey[]; pathname: string | null }) {
  const items = NAV_ITEMS.filter((entry) => keys.includes(entry.key));
  return (
    <nav aria-label={TEXTS.shell.mainNav}>
      <ul className="flex flex-col gap-1">
        {items.map((entry) => {
          const active = pathname !== null && isActive(entry, pathname);
          return (
            <li key={entry.key}>
              <Link
                href={entry.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                )}
              >
                <entry.icon aria-hidden className="size-4" />
                {entry.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
