export const THEME_STORAGE_KEY = "fakturan-theme";
export const THEME_EVENT = "fakturan-theme-change";

export type ThemeChoice = "light" | "dark" | "system";

export function parseTheme(value: string | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

// Runs before first paint, so a stored or system dark choice never flashes light.
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
