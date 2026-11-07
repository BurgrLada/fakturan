import { describe, expect, test } from "vitest";
import {
  isQuickSearchShortcut,
  MIN_QUERY_LENGTH,
  staticHits,
  type ShortcutEvent,
} from "@/lib/quick-search";

describe("statické položky rychlého hledání", () => {
  test("[UI-010] staticHits najde „pošta“ v záložkách Nastavení bez diakritiky", () => {
    expect(staticHits("posta", "user")).toEqual([
      expect.objectContaining({ group: "page", label: "Pošta", href: "/nastaveni/posta" }),
    ]);
    expect(staticHits("POŠTA", "user").map((hit) => hit.href)).toEqual(["/nastaveni/posta"]);
  });

  test("[UI-010] staticHits najde sekci navigace a správu jen pro správce", () => {
    expect(staticHits("faktur", "user").map((hit) => hit.href)).toContain("/faktury");
    expect(staticHits("administr", "user")).toEqual([]);
    expect(staticHits("administr", "admin").map((hit) => hit.href)).toEqual(["/administrace"]);
    expect(staticHits("administr", null)).toEqual([]);
  });

  test("[UI-010] staticHits nehledá pod 2 znaky a % ani _ nejsou zástupné znaky", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(staticHits("p", "user")).toEqual([]);
    expect(staticHits("%", "user")).toEqual([]);
    expect(staticHits("p_", "user")).toEqual([]);
  });
});

describe("zkratka rychlého hledání", () => {
  const key = (over: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
    key: "k",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...over,
  });

  test("[UI-010] [UI-008] na Macu otevírá jen ⌘K, jinde jen Ctrl+K", () => {
    expect(isQuickSearchShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isQuickSearchShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isQuickSearchShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isQuickSearchShortcut(key({ ctrlKey: true, key: "K" }), false)).toBe(true);
    expect(isQuickSearchShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isQuickSearchShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isQuickSearchShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isQuickSearchShortcut(key({ ctrlKey: true, key: "j" }), false)).toBe(false);
  });

  test("[UI-008] během skládání znaku (IME) zkratka nic neotevře", () => {
    expect(isQuickSearchShortcut(key({ ctrlKey: true, isComposing: true }), false)).toBe(false);
    expect(isQuickSearchShortcut(key({ metaKey: true, isComposing: true }), true)).toBe(false);
  });
});
