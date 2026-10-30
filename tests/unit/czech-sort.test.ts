import { describe, expect, test } from "vitest";
import { czechSortKey } from "@/lib/czech-sort";

const sorted = (words: string[]) =>
  [...words].sort((a, b) => (czechSortKey(a) < czechSortKey(b) ? -1 : 1));

describe("české řazení", () => {
  test("[CUS-001] Č následuje za C, Ch za H a diakritika samohlásek se při řazení nerozlišuje", () => {
    expect(
      sorted(["Zeta", "Čaj", "Cukr", "Šimek", "Hrad", "Chata", "Ivan", "Álfa", "Alfa2"]),
    ).toEqual(["Álfa", "Alfa2", "Cukr", "Čaj", "Hrad", "Chata", "Ivan", "Šimek", "Zeta"]);
  });

  test("[CUS-001] velikost písmen řazení nemění a čísla jdou před písmena", () => {
    expect(sorted(["beta", "Alfa", "2 firma", "alfa"])).toEqual([
      "2 firma",
      "Alfa",
      "alfa",
      "beta",
    ]);
  });
});
