"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SETTINGS_TABS } from "@/lib/nav";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

const FADE = "2.5rem";

export function SettingsTabs() {
  return <SettingsTabsView pathname={usePathname()} />;
}

export function SettingsTabsView({ pathname }: { pathname: string | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    scroller.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  const page = (direction: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.7, behavior: "smooth" });
  };

  // A mask reads only alpha, so currentColor stands for "fully visible".
  const solid = "currentColor";
  const mask = `linear-gradient(to right, ${edges.start ? "transparent" : solid}, ${solid} ${FADE}, ${solid} calc(100% - ${FADE}), ${edges.end ? "transparent" : solid})`;

  return (
    <nav aria-label={TEXTS.settings.nav} className="relative border-b">
      <div
        ref={scroller}
        onScroll={measure}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
        className="flex snap-x gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SETTINGS_TABS.map((tab) => {
          const active = pathname !== null && pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative shrink-0 snap-start whitespace-nowrap rounded-t-md px-3 py-2.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:bg-muted",
                "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                active && "font-medium text-foreground after:bg-primary",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      {/* Pointer-only: keyboard users reach every tab with Tab, and the buttons would be extra stops. */}
      <EdgeButton side="start" visible={edges.start} onClick={() => page(-1)} />
      <EdgeButton side="end" visible={edges.end} onClick={() => page(1)} />
    </nav>
  );
}

function EdgeButton({
  side,
  visible,
  onClick,
}: {
  side: "start" | "end";
  visible: boolean;
  onClick: () => void;
}) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={side === "start" ? TEXTS.settings.tabsBack : TEXTS.settings.tabsForward}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 hidden size-7 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-opacity hover:text-foreground pointer-fine:flex",
        side === "start" ? "left-0" : "right-0",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Icon aria-hidden className="size-4" />
    </button>
  );
}
