"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { quickSearch } from "@/app/(app)/hledani-actions";
import { Button } from "@/components/ui/button";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SEARCH_DELAY_MS,
  SEARCH_GROUPS,
  staticHits,
  type SearchHit,
} from "@/lib/quick-search";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";

const T = TEXTS.quickSearch;

type QuickSearchState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  returnTo: RefObject<HTMLElement | null>;
};

const QuickSearchContext = createContext<QuickSearchState | null>(null);

function useQuickSearch(): QuickSearchState {
  const state = useContext(QuickSearchContext);
  if (!state) throw new Error("QuickSearchProvider is missing");
  return state;
}

function isShortcut(event: globalThis.KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

export function QuickSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isShortcut(event)) return;
      event.preventDefault();
      if (open) return;
      returnTo.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const value = useMemo(() => ({ open, setOpen, returnTo }), [open]);
  return <QuickSearchContext.Provider value={value}>{children}</QuickSearchContext.Provider>;
}

const noSubscription = () => () => {};
const onApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

export function QuickSearchTrigger({ compact = false }: { compact?: boolean }) {
  const { setOpen, returnTo } = useQuickSearch();
  const apple = useSyncExternalStore(noSubscription, onApple, () => false);
  return (
    <Button
      type="button"
      variant="outline"
      size={compact ? "icon" : "default"}
      aria-label={T.open}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className={compact ? undefined : "w-full justify-start text-muted-foreground"}
      onClick={(event) => {
        returnTo.current = event.currentTarget;
        setOpen(true);
      }}
    >
      <Search aria-hidden />
      {!compact && (
        <>
          <span>{T.open}</span>
          <kbd
            aria-hidden
            className="ml-auto rounded-sm border bg-muted px-1 font-sans text-[0.625rem]"
          >
            {apple ? "⌘K" : "Ctrl K"}
          </kbd>
        </>
      )}
    </Button>
  );
}

export function QuickSearch({ role }: { role: string | null }) {
  const { open, setOpen, returnTo } = useQuickSearch();
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/60 supports-backdrop-filter:backdrop-blur-xs" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={() => returnTo.current ?? true}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none"
        >
          <Dialog.Title className="sr-only">{T.title}</Dialog.Title>
          <SearchPanel
            role={role}
            input={input}
            onChoose={(hit) => {
              setOpen(false);
              router.push(hit.href);
            }}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Remote = { term: string; hits: SearchHit[]; limited: boolean; failed: boolean };

const keyOf = (hit: SearchHit) => `${hit.group}:${hit.id}`;
const rank = (hit: SearchHit) => SEARCH_GROUPS.indexOf(hit.group);

function SearchPanel({
  role,
  input,
  onChoose,
}: {
  role: string | null;
  input: RefObject<HTMLInputElement | null>;
  onChoose: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Remote | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const term = query.trim();
  const ready = term.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!ready) return;
    let current = true;
    const timer = setTimeout(() => {
      quickSearch(term).then(
        (reply) => current && setRemote({ term, ...reply, failed: false }),
        () => current && setRemote({ term, hits: [], limited: false, failed: true }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [term, ready]);

  const answered = ready && remote?.term === term ? remote : null;
  const hits = useMemo(
    () => [...(answered?.hits ?? []), ...staticHits(term, role)].sort((a, b) => rank(a) - rank(b)),
    [answered, term, role],
  );
  const active = activeKey ? hits.findIndex((hit) => keyOf(hit) === activeKey) : -1;
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (active >= 0)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && hits.length > 0) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        active < 0 ? (step > 0 ? 0 : hits.length - 1) : (active + step + hits.length) % hits.length;
      setActiveKey(keyOf(hits[next]!));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      onChoose(hits[active]!);
    }
  }

  const status = !ready
    ? T.tooShort
    : answered?.limited
      ? T.limited
      : answered?.failed
        ? T.failed
        : hits.length > 0
          ? T.found(hits.length)
          : answered
            ? T.empty
            : T.searching;

  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 has-[input:focus-visible]:bg-muted/40">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-label={T.input}
          aria-describedby={hintId}
          aria-autocomplete="list"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          placeholder={T.placeholder}
          maxLength={MAX_QUERY_LENGTH}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={T.results}
        className="min-h-0 flex-1 overflow-y-auto p-1 empty:hidden"
      >
        {SEARCH_GROUPS.map((group) => {
          const inGroup = hits.filter((hit) => hit.group === group);
          if (inGroup.length === 0) return null;
          const headingId = `${baseId}-${group}`;
          return (
            <div key={group} role="group" aria-labelledby={headingId} className="py-1">
              <div
                id={headingId}
                role="presentation"
                className="px-2 py-1 text-xs font-medium text-muted-foreground"
              >
                {T.groups[group]}
              </div>
              {inGroup.map((hit) => {
                const position = hits.indexOf(hit);
                return (
                  <div
                    key={keyOf(hit)}
                    id={optionId(position)}
                    role="option"
                    aria-selected={position === active}
                    className={cn(
                      "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                      position === active && "bg-muted ring-1 ring-ring",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => position !== active && setActiveKey(keyOf(hit))}
                    onClick={() => onChoose(hit)}
                  >
                    <span className="truncate font-medium">{hit.label}</span>
                    {hit.detail && (
                      <span className="truncate text-xs text-muted-foreground">{hit.detail}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <p role="status">{status}</p>
        <p id={hintId}>{T.hint}</p>
      </div>
    </>
  );
}
