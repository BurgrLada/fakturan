import { describe, expect, test } from "vitest";
import { NAV_ITEMS, visibleNavItems } from "@/components/nav";
import { TEXTS } from "@/lib/texts";

describe("navigace", () => {
  test("[UI-006] popisky navigace pocházejí z modulu s texty", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Přehled",
      "Faktury",
      "Pravidelné",
      "Zákazníci",
      "Ceník",
      "Platby",
      "Statistiky",
      "Nastavení",
      "Administrace",
    ]);
    for (const item of NAV_ITEMS) expect(item.label).toBe(TEXTS.nav[item.key]);
  });

  test("[ADM-001] položka Administrace se ukáže jen administrátorovi", () => {
    const labels = (role: string) => visibleNavItems(role, true).map((item) => item.key);
    expect(labels("admin")).toContain("admin");
    expect(labels("user")).not.toContain("admin");
  });

  test("[UI-009] nehotové sekce vedou na prázdný stav a jedním příznakem se skryjí", () => {
    const planned = NAV_ITEMS.filter((item) => item.planned);
    const hidden = visibleNavItems("admin", false).map((item) => item.key);
    for (const item of planned) expect(hidden).not.toContain(item.key);
    expect(hidden).toEqual(NAV_ITEMS.filter((item) => !item.planned).map((item) => item.key));
    expect(hidden).toContain("reports");
  });
});
