"use client";

import { useEffect } from "react";
import { parseTheme, saveTheme, themeChosenLocally, readStoredTheme } from "@/lib/theme";

export function ThemeSync({ theme }: { theme?: string | null }) {
  useEffect(() => {
    if (themeChosenLocally()) return;
    const account = parseTheme(theme ?? null);
    if (readStoredTheme() !== account) saveTheme(account);
  }, [theme]);
  return null;
}
