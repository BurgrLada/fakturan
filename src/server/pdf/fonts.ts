import "server-only";
import { join } from "node:path";
import { Font } from "@react-pdf/renderer";

// Read from process.cwd() at runtime; next.config.ts lists this folder for output tracing.
const DIR = join(process.cwd(), "src/server/pdf/fonts");

const FILES = {
  Inter: "Inter",
  "Source Serif 4": "SourceSerif4",
  "JetBrains Mono": "JetBrainsMono",
} as const;

export const FONT_FAMILIES = Object.keys(FILES) as (keyof typeof FILES)[];

const MAX_UNBROKEN_WORD = 30;

let registered = false;

export function registerFonts(): void {
  if (registered) return;
  registered = true;
  for (const family of FONT_FAMILIES) {
    Font.register({
      family,
      fonts: [
        { src: join(DIR, `${FILES[family]}-Regular.ttf`), fontWeight: 400 },
        { src: join(DIR, `${FILES[family]}-Bold.ttf`), fontWeight: 700 },
      ],
    });
  }
  // The empty syllables stop react-pdf from printing a hyphen at each break of a long word.
  Font.registerHyphenationCallback((word) =>
    word.length > MAX_UNBROKEN_WORD ? Array.from(word).flatMap((char) => [char, ""]) : [word],
  );
}

type LoadableSource = { data: unknown; loadResultPromise: Promise<void> | null };

// Embedding a subset caches composite components (y of ý, C of Č) in fontkit without code points, and
// the next document's text layer would lose those letters. Only a freshly parsed font is clean, and
// Font.reset() alone leaves the finished load promise, so the font would never parse again.
export function reloadFonts(): void {
  const families = Font.getRegisteredFonts() as unknown as Record<
    string,
    { sources: LoadableSource[] }
  >;
  for (const family of FONT_FAMILIES) {
    for (const source of families[family]?.sources ?? []) {
      source.data = null;
      source.loadResultPromise = null;
    }
  }
}
