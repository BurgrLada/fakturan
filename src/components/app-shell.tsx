"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

const SIDEBAR_ID = "sidebar";

export function AppShell({
  nav,
  bell,
  account,
  children,
}: {
  nav: ReactNode;
  bell: ReactNode;
  account: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-svh flex-1 flex-col md:flex-row">
      <a
        href="#obsah"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-2"
      >
        {TEXTS.shell.skipToContent}
      </a>
      <div className="flex items-center justify-between border-b bg-sidebar px-4 py-2 md:hidden">
        <Link href="/" aria-label={TEXTS.shell.home} className="rounded-sm font-brand text-lg">
          {TEXTS.appName}
        </Link>
        <div className="flex items-center gap-2">
          {bell}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-expanded={open}
            aria-controls={SIDEBAR_ID}
            aria-label={open ? TEXTS.shell.closeMenu : TEXTS.shell.openMenu}
            onClick={() => setOpen(!open)}
          >
            {open ? <X /> : <Menu />}
          </Button>
        </div>
      </div>
      {/* Closing on link clicks keeps the shell free of usePathname, which would block prerendering dynamic routes. */}
      <aside
        id={SIDEBAR_ID}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className={cn(
          "flex-col gap-6 border-b bg-sidebar p-4 text-sidebar-foreground md:sticky md:top-0 md:flex md:h-svh md:w-60 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0",
          open ? "flex" : "hidden",
        )}
      >
        <div className="flex items-center justify-between">
          <Link href="/" aria-label={TEXTS.shell.home} className="rounded-sm">
            <Logo className="w-36" />
          </Link>
          <div className="hidden md:block">{bell}</div>
        </div>
        {nav}
        <div className="mt-auto flex flex-col gap-3">
          <ThemeToggle />
          {account}
        </div>
      </aside>
      <main id="obsah" className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">{children}</div>
      </main>
    </div>
  );
}
