import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NAV_ITEMS } from "@/components/nav";
import { staticHits } from "@/lib/quick-search";
import { TEXTS } from "@/lib/texts";

const APP = join("src", "app");

// A URL segment matches a folder of the same name inside any route group, or a dynamic folder.
function routeExists(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const walk = (dir: string, rest: string[]): boolean => {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    const groups = entries.filter((entry) => /^\(.+\)$/.test(entry.name));
    if (groups.some((group) => walk(join(dir, group.name), rest))) return true;
    if (rest.length === 0) return existsSync(join(dir, "page.tsx"));
    const [head, ...tail] = rest;
    return entries
      .filter((entry) => entry.name === head || /^\[[^.]+\]$/.test(entry.name))
      .some((entry) => walk(join(dir, entry.name), tail));
  };
  return walk(APP, segments);
}

const H = TEXTS.help;
const chapterText = (chapter: (typeof H.chapters)[number]) =>
  [chapter.title, ...chapter.body].join("\n");
const TAX_WORDS = /daň|daní|DPH|přiznání/i;

describe("Nápověda", () => {
  test("[UI-012] Nápověda je v navigaci před Nastavením a má aspoň 12 otázek", () => {
    const keys = NAV_ITEMS.map((item) => item.key);
    expect(keys.indexOf("help")).toBe(keys.indexOf("settings") - 1);
    const help = NAV_ITEMS.find((item) => item.key === "help");
    expect(help).toMatchObject({ href: "/napoveda", label: "Nápověda", adminOnly: false });
    expect(H.faq.length).toBeGreaterThanOrEqual(12);
    for (const item of H.faq) {
      expect(item.q.trim()).not.toBe("");
      expect(item.a.trim()).not.toBe("");
    }
    expect(H.chapters.length).toBeGreaterThanOrEqual(13);
    const ids = H.chapters.map((chapter) => chapter.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  test("[UI-012] každý odkaz v Nápovědě míří na existující stránku", () => {
    type HelpLink = { label: string; href: string };
    const links = H.chapters.flatMap((chapter): readonly HelpLink[] => chapter.links);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      expect(link.href).toMatch(/^\/(?!\/)/);
      expect(link.label.trim()).not.toBe("");
      const path = link.href.split("#")[0] ?? "/";
      expect(routeExists(path), link.href).toBe(true);
    }
    expect(routeExists("/neexistuje")).toBe(false);
    expect(routeExists("/faktury/abc/upravit")).toBe(true);
  });

  test("[UI-012] daňové kapitoly nesou upozornění TEXTS.tax.disclaimer", () => {
    const taxChapters = H.chapters.filter((chapter) => TAX_WORDS.test(chapterText(chapter)));
    expect(taxChapters.map((chapter) => chapter.id)).toContain("dane");
    for (const chapter of taxChapters) expect(chapter.body).toContain(TEXTS.tax.disclaimer);
    for (const item of H.faq.filter((entry) => TAX_WORDS.test(`${entry.q}\n${entry.a}`))) {
      expect(item.a).toContain(TEXTS.tax.disclaimer);
    }
  });

  test("[UI-010] Ctrl+K najde kapitolu „opravné faktury“", () => {
    const hits = staticHits("opravne faktury", "user");
    expect(hits).toContainEqual(
      expect.objectContaining({
        group: "page",
        href: "/napoveda#opravne-faktury",
        detail: TEXTS.quickSearch.help,
      }),
    );
    expect(staticHits("faktur", "user").map((hit) => hit.href)).toContain("/faktury");
  });
});
