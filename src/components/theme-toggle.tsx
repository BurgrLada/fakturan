"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { setThemeAction } from "@/app/actions";
import { readStoredTheme, saveTheme, THEME_EVENT, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "light", label: TEXTS.theme.light, icon: Sun },
  { value: "dark", label: TEXTS.theme.dark, icon: Moon },
  { value: "system", label: TEXTS.theme.system, icon: Monitor },
];

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
  const choice = useSyncExternalStore(subscribe, readStoredTheme, () => "system" as ThemeChoice);

  useEffect(() => {
    apply(choice);
    if (choice !== "system") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [choice]);

  function select(next: ThemeChoice) {
    saveTheme(next, true);
    apply(next);
    setThemeAction({ theme: next }).catch(() => {});
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
