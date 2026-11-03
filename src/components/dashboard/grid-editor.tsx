"use client";

import { GripVertical, Settings2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import GridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
// Loaded with the editor chunk only; the overrides must come after the library's own rules.
import "react-grid-layout/css/styles.css";
import "./grid-editor.css";
import { removeWidgetAction, saveLayoutAction } from "@/app/(app)/dashboardy/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  compactLayout,
  GRID_COLUMNS,
  MAX_H,
  MIN_H,
  MIN_W,
  moveWidget,
  resizeWidget,
  type LayoutItem,
} from "@/lib/dashboard-layout";
import { setLeaveGuard } from "@/lib/leave-guard";
import { TEXTS } from "@/lib/texts";
import { ExportButton } from "./export-button";
import { LayoutButtons, type LayoutStep } from "./layout-buttons";

const T = TEXTS.dashboard.edit;
const S = TEXTS.dashboard.share;

// Matches the read-only grid of the overview: 4.5rem rows and a 1rem gap.
const ROW_HEIGHT = 72;
const GAP = 16;

export type EditorWidget = LayoutItem & {
  title: string;
  summary: string;
  pinned: boolean;
  broken: boolean;
};

type Saved = { revision: number; items: LayoutItem[] };

const boxOf = ({ id, x, y, w, h }: LayoutItem): LayoutItem => ({ id, x, y, w, h });

function sameBoxes(a: LayoutItem[], b: LayoutItem[]): boolean {
  const byId = new Map(b.map((item) => [item.id, item]));
  return (
    a.length === b.length &&
    a.every((item) => {
      const other = byId.get(item.id);
      return (
        other !== undefined &&
        other.x === item.x &&
        other.y === item.y &&
        other.w === item.w &&
        other.h === item.h
      );
    })
  );
}

function fromGrid(layout: Layout): LayoutItem[] {
  return layout.map(({ i, x, y, w, h }) => ({ id: i, x, y, w, h }));
}

function useLeaveWarning(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    // Next has no way to block a navigation, so links are stopped before its handler sees them.
    const guardLink = (event: MouseEvent) => {
      if (!dirtyRef.current) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target || link.hasAttribute("download")) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      if (window.confirm(T.leaveConfirm)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const dropGuard = setLeaveGuard(
      async () => !dirtyRef.current || window.confirm(T.leaveConfirm),
    );
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => {
      dropGuard();
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLink, true);
    };
  }, []);
}

export function GridEditor({
  dashboard,
  widgets,
}: {
  dashboard: { id: string; revision: number };
  widgets: EditorWidget[];
}) {
  const router = useRouter();
  const [seen, setSeen] = useState(dashboard.revision);
  const [items, setItems] = useState<LayoutItem[]>(() => widgets.map(boxOf));
  const [saved, setSaved] = useState<Saved>(() => ({
    revision: dashboard.revision,
    items: widgets.map(boxOf),
  }));
  const [announcement, setAnnouncement] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [removing, setRemoving] = useState<EditorWidget | null>(null);
  const [pending, startTransition] = useTransition();
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });

  // Only a revision newer than the one saved here (a removed widget) replaces the local state;
  // the refresh after our own save carries the revision we already hold.
  if (dashboard.revision !== seen) {
    setSeen(dashboard.revision);
    if (dashboard.revision > saved.revision) {
      setItems(widgets.map(boxOf));
      setSaved({ revision: dashboard.revision, items: widgets.map(boxOf) });
    }
  }

  const dirty = !sameBoxes(items, saved.items);
  useLeaveWarning(dirty);

  const titles = new Map(widgets.map((widget) => [widget.id, widget.title]));

  function announce(next: LayoutItem[], id: string) {
    const item = next.find((entry) => entry.id === id);
    const title = titles.get(id) ?? "";
    if (!item) return;
    const before = items.find((entry) => entry.id === id);
    const unchanged = sameBoxes(next, items) && before !== undefined;
    setAnnouncement(
      unchanged ? T.edge(title) : T.position(title, item.x + 1, item.y + 1, item.w, item.h),
    );
  }

  function apply(next: LayoutItem[], id: string) {
    announce(next, id);
    setItems(next.map(boxOf));
    setMessage(null);
  }

  function step(id: string, change: LayoutStep) {
    const current = items.find((item) => item.id === id);
    if (!current) return;
    const next =
      change.kind === "move"
        ? moveWidget(items, id, change.direction)
        : resizeWidget(items, id, { w: current.w + change.dw, h: current.h + change.dh });
    apply(next, id);
  }

  function fromDrag(layout: Layout, moved: { i: string } | null) {
    if (!moved) return;
    apply(compactLayout(fromGrid(layout), moved.i), moved.i);
  }

  function failure(reply: { error: string; expired?: true }) {
    setMessage({ ok: false, text: reply.expired ? T.expired : reply.error });
  }

  async function persist(): Promise<boolean> {
    try {
      const reply = await saveLayoutAction({ id: dashboard.id, revision: saved.revision, items });
      if (!reply.ok) {
        failure(reply);
        return false;
      }
      setSaved({ revision: reply.revision, items: reply.items });
      setItems(reply.items);
      return true;
    } catch {
      setMessage({ ok: false, text: T.failed });
      return false;
    }
  }

  function save() {
    startTransition(async () => {
      if (await persist()) setMessage({ ok: true, text: T.saved });
    });
  }

  function remove(widget: EditorWidget) {
    setRemoving(null);
    startTransition(async () => {
      if (dirty && !(await persist())) return;
      try {
        const reply = await removeWidgetAction({ id: widget.id });
        if (!reply.ok) return failure(reply);
        setMessage({ ok: true, text: T.removed(widget.title) });
        router.refresh();
      } catch {
        setMessage({ ok: false, text: T.failed });
      }
    });
  }

  const layout: Layout = items.map(({ id, x, y, w, h }) => ({
    i: id,
    x,
    y,
    w,
    h,
    minW: MIN_W,
    minH: MIN_H,
    maxH: MAX_H,
  }));
  const byId = new Map(items.map((item) => [item.id, item]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={!dirty || pending}>
          {pending ? T.saving : T.save}
        </Button>
        <p className="text-sm text-muted-foreground" data-testid="layout-state">
          {dirty ? T.unsaved : T.clean}
        </p>
      </div>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{T.hint}</p>
      <p role="status" aria-live="polite" className="sr-only" data-testid="layout-announcement">
        {announcement}
      </p>
      <div ref={containerRef} aria-label={T.grid} role="region" data-testid="grid-editor">
        {mounted && (
          <GridLayout
            width={width}
            layout={layout}
            gridConfig={{
              cols: GRID_COLUMNS,
              rowHeight: ROW_HEIGHT,
              margin: [GAP, GAP],
              containerPadding: [0, 0],
            }}
            dragConfig={{ handle: ".widget-drag", cancel: "button, a, input, select" }}
            resizeConfig={{ handles: ["se"] }}
            onDragStop={(next, _old, moved) => fromDrag(next, moved)}
            onResizeStop={(next, _old, resized) => fromDrag(next, resized)}
          >
            {widgets.map((widget) => {
              const box = byId.get(widget.id) ?? widget;
              return (
                <section
                  key={widget.id}
                  aria-labelledby={`edit-${widget.id}-title`}
                  data-testid="edit-widget"
                  data-widget-id={widget.id}
                  data-box={`${box.x},${box.y},${box.w},${box.h}`}
                  className="flex flex-col gap-2 overflow-auto rounded-lg border bg-card p-3 text-card-foreground"
                >
                  <div className="widget-drag flex cursor-grab items-center gap-1 active:cursor-grabbing">
                    <GripVertical aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <h2 id={`edit-${widget.id}-title`} className="truncate text-sm font-medium">
                      {widget.title}
                    </h2>
                  </div>
                  <p className="text-xs text-muted-foreground">{widget.summary}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {T.box(box.x + 1, box.y + 1, box.w, box.h)}
                  </p>
                  <LayoutButtons
                    title={widget.title}
                    onStep={(change) => step(widget.id, change)}
                  />
                  <div className="flex flex-wrap gap-1">
                    <Link
                      href={`/dashboardy/${dashboard.id}/widget/${widget.id}`}
                      aria-label={T.configureLabel(widget.title)}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      <Settings2 aria-hidden />
                      {T.configure}
                    </Link>
                    {!widget.broken && (
                      <ExportButton
                        href={`/dashboardy/${dashboard.id}/widget/${widget.id}/export`}
                        label={S.exportWidget}
                        ariaLabel={S.exportWidgetLabel(widget.title)}
                        size="sm"
                      />
                    )}
                    {widget.pinned ? (
                      <p className="text-xs text-muted-foreground">{T.pinned}</p>
                    ) : (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        aria-label={T.removeLabel(widget.title)}
                        onClick={() => setRemoving(widget)}
                      >
                        <Trash2 aria-hidden />
                        {T.remove}
                      </Button>
                    )}
                  </div>
                </section>
              );
            })}
          </GridLayout>
        )}
      </div>
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{removing && T.removeTitle(removing.title)}</AlertDialogTitle>
            <AlertDialogDescription>{T.removeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => removing && remove(removing)}
            >
              {T.remove}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
