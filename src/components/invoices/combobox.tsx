"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SEARCH_DELAY_MS = 200;

export function Combobox<T>({
  id,
  value,
  invalid,
  placeholder,
  onValueChange,
  search,
  optionKey,
  renderOption,
  onSelect,
  extra,
}: {
  id: string;
  value: string;
  invalid?: boolean;
  placeholder?: string;
  onValueChange: (value: string) => void;
  search: (query: string) => Promise<T[]>;
  optionKey: (option: T) => string;
  renderOption: (option: T) => ReactNode;
  onSelect: (option: T) => void;
  extra?: { label: (query: string) => string; onSelect: (query: string) => void };
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<T[]>([]);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(0);
  const listId = `${id}-list`;
  const total = options.length + (extra ? 1 : 0);

  function close() {
    if (timer.current) clearTimeout(timer.current);
    latest.current += 1;
    setOpen(false);
    setActive(-1);
  }

  function lookUp(query: string, delay: number) {
    if (timer.current) clearTimeout(timer.current);
    latest.current += 1;
    const ticket = latest.current;
    timer.current = setTimeout(() => {
      search(query)
        .catch(() => [] as T[])
        .then((found) => {
          if (ticket !== latest.current) return;
          setOptions(found);
          setActive(-1);
          setOpen(true);
        });
    }, delay);
  }

  function choose(index: number) {
    const option = options[index];
    if (option !== undefined) onSelect(option);
    else extra?.onSelect(value);
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        lookUp(value, 0);
      } else if (total > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => (current + step + total) % total);
      }
    } else if (event.key === "Enter" && open && active >= 0) {
      event.preventDefault();
      choose(active);
    }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          lookUp(event.target.value, SEARCH_DELAY_MS);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      {open && total > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full min-w-56 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.map((option, index) => (
            <li
              key={optionKey(option)}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-1 text-sm hover:bg-muted md:text-xs/relaxed",
                index === active && "bg-muted",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              {renderOption(option)}
            </li>
          ))}
          {extra && (
            <li
              id={`${listId}-${options.length}`}
              role="option"
              aria-selected={active === options.length}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-1 text-sm font-medium hover:bg-muted md:text-xs/relaxed",
                active === options.length && "bg-muted",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(options.length)}
            >
              {extra.label(value.trim())}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
