"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { parseTheme, THEME_EVENT, THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "light", label: TEXTS.theme.light, icon: Sun },
  { value: "dark", label: TEXTS.theme.dark, icon: Moon },
  { value: "system", label: TEXTS.theme.system, icon: Monitor },
];

function readStored(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice) {
  const dark =
    choice === "dark" ||
    (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, readStored, () => "system" as ThemeChoice);

  useEffect(() => {
    apply(choice);
    if (choice !== "system") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  function select(next: ThemeChoice) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be blocked; the choice then lasts until reload.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
    apply(next);
  }

  return (
    <div role="group" aria-label={TEXTS.theme.group} className="flex gap-1">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          type="button"
          variant={choice === value ? "secondary" : "ghost"}
          size="icon"
          aria-label={label}
          aria-pressed={choice === value}
          title={label}
          onClick={() => select(value)}
        >
          <Icon />
        </Button>
      ))}
    </div>
  );
}
