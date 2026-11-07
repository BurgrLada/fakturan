import { describe, expect, test } from "vitest";
import { MIN_QUERY_LENGTH, staticHits } from "@/lib/quick-search";

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
