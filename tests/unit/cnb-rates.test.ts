import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseDailyRates } from "@/lib/cnb-rates";

const fixture = (name: string) => readFileSync(join(__dirname, "../fixtures/cnb", name), "utf8");
const TITLE = "30.10.2026 #211\nzemě|měna|množství|kód|kurz\n";

describe("denní lístek ČNB", () => {
  test("[FOR-004] parser přečte EUR 24,380 jako 24 380 000 mikro", () => {
    const parsed = parseDailyRates(fixture("denni-kurz.txt"));
    expect(parsed?.listDate).toBe("2026-10-30");
    expect(parsed?.rates.find((item) => item.currency === "EUR")?.rateMicros).toBe(24_380_000);
  });

  test("[FOR-004] vrací jen měny aplikace bez CZK a ostatní řádky zahodí", () => {
    const parsed = parseDailyRates(fixture("denni-kurz.txt"));
    expect(parsed?.rates).toEqual([
      { currency: "EUR", rateMicros: 24_380_000 },
      { currency: "PLN", rateMicros: 5_731_000 },
      { currency: "CHF", rateMicros: 26_512_000 },
      { currency: "USD", rateMicros: 22_311_000 },
      { currency: "GBP", rateMicros: 28_215_000 },
    ]);
  });

  test("[TST-012] lístek 100|HUF|37,512 dá 375 120 mikro za 1 jednotku", () => {
    const parsed = parseDailyRates(
      `${TITLE}Maďarsko|forint|100|HUF|37,512\nEMU|euro|1|EUR|24,380\n`,
    );
    expect(parsed?.rates).toEqual([{ currency: "EUR", rateMicros: 24_380_000 }]);
    const hungarian = parseDailyRates(`${TITLE}Maďarsko|forint|100|HUF|37,512\n`);
    expect(hungarian).toEqual({ listDate: "2026-10-30", rates: [] });
  });

  test("[FOR-003] lístek z víkendu nese datum pátku", () => {
    expect(parseDailyRates(fixture("vikend.txt"))?.listDate).toBe("2026-10-30");
  });

  test("[FOR-004] konec řádku CRLF a chybějící poslední nový řádek nevadí", () => {
    const crlf = fixture("vikend.txt").replaceAll("\n", "\r\n");
    expect(parseDailyRates(crlf)?.rates).toHaveLength(3);
    expect(parseDailyRates(fixture("vikend.txt").trimEnd())?.rates).toHaveLength(3);
  });

  const broken: [string, string][] = [
    ["prázdný text", ""],
    ["jen hlavička", "30.10.2026 #211\n"],
    ["bez řádků s kurzy", `${TITLE}`],
    ["rozbité datum", `30.10 #211\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n`],
    ["neexistující datum", `31.11.2026 #211\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n`],
    ["datum bez čísla lístku", `30.10.2026\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n`],
    ["jiná hlavička", `30.10.2026 #211\nzemě|měna|kód|množství|kurz\nEMU|euro|1|EUR|24,380\n`],
    ["chybějící sloupec", `${TITLE}EMU|euro|1|EUR\n`],
    ["přebývající sloupec", `${TITLE}EMU|euro|1|EUR|24,380|x\n`],
    ["nulový kurz", `${TITLE}EMU|euro|1|EUR|0,000\n`],
    ["tisícový oddělovač", `${TITLE}EMU|euro|1|EUR|1.234,56\n`],
    ["nulové množství", `${TITLE}EMU|euro|0|EUR|24,380\n`],
    ["neplatný kód", `${TITLE}EMU|euro|1|eur|24,380\n`],
    ["prázdná země", `${TITLE}|euro|1|EUR|24,380\n`],
    ["prázdná měna", `${TITLE}EMU||1|EUR|24,380\n`],
    ["zdvojený kód", `${TITLE}EMU|euro|1|EUR|24,380\nEMU|euro|1|EUR|24,381\n`],
    ["vadný řádek ignorované měny", `${TITLE}EMU|euro|1|EUR|24,380\nJaponsko|jen|100|JPY|x\n`],
    ["prázdný řádek uprostřed", `${TITLE}EMU|euro|1|EUR|24,380\n\nUSA|dolar|1|USD|22,311\n`],
    ["příliš dlouhý řádek", `${TITLE}EMU|${"x".repeat(300)}|1|EUR|24,380\n`],
  ];

  test.each(broken)("[FOR-004] %s dá null", (_name, text) => {
    expect(parseDailyRates(text)).toBeNull();
  });

  test("[FOR-004] datum s jednociferným dnem a měsícem se doplní nulami", () => {
    const parsed = parseDailyRates(
      "5.1.2026 #3\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n",
    );
    expect(parsed?.listDate).toBe("2026-01-05");
  });

  test("[FOR-004] samotný CR jako konec řádku se přijme", () => {
    const text = fixture("vikend.txt").replaceAll("\n", "\r");
    expect(parseDailyRates(text)?.rates).toHaveLength(3);
  });

  test("[FOR-004] řádek dlouhý přesně 200 znaků projde a 201 ne", () => {
    const line = (size: number) =>
      `${"Z".repeat(size - "|euro|1|EUR|24,380".length)}|euro|1|EUR|24,380`;
    expect(parseDailyRates(`${TITLE}${line(200)}\n`)?.rates).toHaveLength(1);
    expect(parseDailyRates(`${TITLE}${line(201)}\n`)).toBeNull();
  });

  test.each([
    ["text před datem", `x30.10.2026 #211\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n`],
    [
      "text za číslem lístku",
      `30.10.2026 #211 x\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,380\n`,
    ],
    ["sedmimístné množství", `${TITLE}EMU|euro|1234567|EUR|24,380\n`],
    ["množství s textem", `${TITLE}EMU|euro|1x|EUR|24,380\n`],
    ["čtyřpísmenný kód", `${TITLE}EMU|euro|1|EURO|24,380\n`],
    ["kód s předponou", `${TITLE}EMU|euro|1|xEUR|24,380\n`],
  ])("[FOR-004] %s dá null", (_name, text) => {
    expect(parseDailyRates(text)).toBeNull();
  });

  test("[FOR-004] koruna z lístku se zahodí, protože nemá kurz", () => {
    const parsed = parseDailyRates(`${TITLE}Česko|koruna|1|CZK|1,000\nEMU|euro|1|EUR|24,380\n`);
    expect(parsed?.rates).toEqual([{ currency: "EUR", rateMicros: 24_380_000 }]);
  });

  test("[FOR-004] pomalé vstupy se zpracují v lineárním čase", () => {
    const started = performance.now();
    parseDailyRates(`${TITLE}${"1".repeat(50_000)}\n`);
    parseDailyRates(`${TITLE}EMU|euro|1|EUR|${"9".repeat(150)},${"9".repeat(40)}\n`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
