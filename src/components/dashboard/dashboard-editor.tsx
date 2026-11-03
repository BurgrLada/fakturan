"use client";

import { Download, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/ui/button";
import { dashboardHref } from "@/lib/dashboard-filter";
import type { DateFormat } from "@/lib/preferences";
import { TEXTS } from "@/lib/texts";
import { DashboardDialogs } from "./dashboard-dialogs";
import type { EditorWidget } from "./grid-editor";
import { ImportDialog } from "./import-dialog";

const T = TEXTS.dashboard.edit;
const S = TEXTS.dashboard.share;

function EditorLoading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {T.loading}
    </p>
  );
}

// R-2: the drag library loads only here, in the browser, and only from the md breakpoint up.
const GridEditor = dynamic(() => import("./grid-editor").then((module) => module.GridEditor), {
  ssr: false,
  loading: EditorLoading,
});

const WIDE = "(min-width: 48rem)";

function subscribe(change: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

export function DashboardEditor({
  dashboard,
  count,
  widgets,
  dateFormat,
}: {
  dashboard: { id: string; name: string; isDefault: boolean; revision: number };
  count: number;
  widgets: EditorWidget[];
  dateFormat: DateFormat;
}) {
  const wide = useWide();
  const overview = dashboardHref(dashboard.isDefault ? null : dashboard.id, {});
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={overview} className={buttonVariants({ variant: "outline" })}>
          {T.back}
        </Link>
        <Link
          href={`/dashboardy/${dashboard.id}/widget/novy`}
          className={buttonVariants({ variant: "default" })}
        >
          <Plus aria-hidden />
          {T.add}
        </Link>
        <form method="post" action={`/dashboardy/${dashboard.id}/export`}>
          <button type="submit" className={buttonVariants({ variant: "outline" })}>
            <Download aria-hidden />
            {S.export}
          </button>
        </form>
        <ImportDialog dateFormat={dateFormat} />
      </div>
      <DashboardDialogs dashboard={dashboard} count={count} />
      <p className="text-sm text-muted-foreground md:hidden" data-testid="edit-narrow">
        {T.narrow}
      </p>
      <div className="hidden md:block">
        {wide ? (
          <GridEditor key={dashboard.id} dashboard={dashboard} widgets={widgets} />
        ) : (
          <EditorLoading />
        )}
      </div>
    </div>
  );
}
