export const THEME_STORAGE_KEY = "fakturan-theme";
export const THEME_EVENT = "fakturan-theme-change";

export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_CHOICES = ["light", "dark", "system"] as const;

export function parseTheme(value: string | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

// Set once the user picks a theme in this page's lifetime; survives client navigations, so a server
// value rendered before the pick (stale layout payload) can never overwrite it.
let chosenLocally = false;

export const themeChosenLocally = () => chosenLocally;

export function readStoredTheme(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function saveTheme(choice: ThemeChoice, local = false): void {
  if (local) chosenLocally = true;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage can be blocked; the choice then lasts until reload.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

// Runs before first paint, so a stored or system dark choice never flashes light.
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
