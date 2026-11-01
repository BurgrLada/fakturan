import { describe, expect, test } from "vitest";
import {
  convertMinor,
  deviationExceeds,
  documentCzkMinor,
  expectedListDate,
  paymentCzkMinor,
  RATE_UNIT,
  rateDate,
  rateFromList,
  toCzkMinor,
} from "@/lib/fx";

describe("kurz za jednotku", () => {
  test("[TST-012] lístek 100|HUF|37,512 dá 375 120 mikro za 1 jednotku", () => {
    expect(rateFromList("37,512", 100)).toBe(375_120);
  });

  test("[FOR-004] parser přečte EUR 24,380 jako 24 380 000 mikro", () => {
    expect(rateFromList("24,380", 1)).toBe(24_380_000);
    expect(rateFromList("24", 1)).toBe(24_000_000);
    expect(RATE_UNIT).toBe(1_000_000);
  });

  test("[TST-012] kurz za tisíc jednotek se zaokrouhlí na mikro půl nahoru", () => {
    expect(rateFromList("1,456", 1000)).toBe(1_456);
    expect(rateFromList("0,001", 3)).toBe(333);
    expect(rateFromList("0,000005", 10)).toBe(1);
    expect(rateFromList("0,000004", 10)).toBeNull();
  });

  test.each([
    ["1.234,56", 1],
    ["1 234,56", 1],
    ["24.380", 1],
    ["0,000", 1],
    ["0", 1],
    ["", 1],
    ["24,3801234", 1],
    ["-24,38", 1],
    ["24,", 1],
    [",5", 1],
    ["24,38", 0],
    ["24,38", -1],
    ["24,38", 1.5],
    ["24,38", Number.NaN],
    ["12345678", 1],
  ])("[FOR-004] %s s množstvím %s dá null", (text, amount) => {
    expect(rateFromList(text, amount)).toBeNull();
  });
});

describe("převod", () => {
  test("[TST-012] 1 234,56 EUR × 25,320000 = 31 259,06 Kč", () => {
    expect(convertMinor(123_456, 25_320_000, RATE_UNIT)).toBe(3_125_906);
    expect(toCzkMinor(123_456, 25_320_000)).toBe(3_125_906);
  });

  test("[TST-012] 333,33 EUR × 24,380000 = 8 126,59 Kč", () => {
    expect(toCzkMinor(33_333, 24_380_000)).toBe(812_659);
  });

  test("[TST-012] -1 234,56 EUR dá -31 259,06 Kč a půl haléře se zaokrouhlí od nuly", () => {
    expect(toCzkMinor(-123_456, 25_320_000)).toBe(-3_125_906);
    expect(convertMinor(1, 500_000, RATE_UNIT)).toBe(1);
    expect(convertMinor(-1, 500_000, RATE_UNIT)).toBe(-1);
    expect(convertMinor(1, 499_999, RATE_UNIT)).toBe(0);
    expect(convertMinor(-1, 499_999, RATE_UNIT)).toBe(0);
    expect(Object.is(convertMinor(-1, 499_999, RATE_UNIT), -0)).toBe(false);
  });

  test("[PAY-006] 100,00 USD na faktuře v EUR při 23,000000 a 25,000000 dá 92,00 EUR", () => {
    expect(convertMinor(10_000, 23_000_000, 25_000_000)).toBe(9_200);
  });

  test("[PAY-006] 333,33 USD při 22,111000 a 25,320000 dá 291,08 EUR", () => {
    expect(convertMinor(33_333, 22_111_000, 25_320_000)).toBe(29_108);
  });

  test("[TST-012] neplatný kurz nebo příliš velký výsledek vyhodí", () => {
    expect(() => convertMinor(1, 0, 1)).toThrow("Neplatný kurz");
    expect(() => convertMinor(1, 1, 0)).toThrow("Neplatný kurz");
    expect(() => convertMinor(1, -1, 1)).toThrow("Neplatný kurz");
    expect(() => convertMinor(1, 1, -1)).toThrow("Neplatný kurz");
    expect(() => convertMinor(1, 1.5, 1)).toThrow("Neplatný kurz");
    expect(() => convertMinor(1, 1, 1.5)).toThrow("Neplatný kurz");
    expect(() => convertMinor(1.5, 1, 1)).toThrow("Neplatná částka");
    expect(() => convertMinor(Number.NaN, 1, 1)).toThrow("Neplatná částka");
    expect(() => convertMinor(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow("příliš velká");
    expect(() => convertMinor(-Number.MAX_SAFE_INTEGER, 2, 1)).toThrow("příliš velká");
    expect(convertMinor(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(convertMinor(-Number.MAX_SAFE_INTEGER, 1, 1)).toBe(-Number.MAX_SAFE_INTEGER);
  });
});

describe("odchylka od ČNB", () => {
  test("[FOR-010] reference 25,000000: 26,250000 a 23,750000 neupozorní, 26,250001 a 23,749999 ano", () => {
    expect(deviationExceeds(26_250_000, 25_000_000)).toBe(false);
    expect(deviationExceeds(23_750_000, 25_000_000)).toBe(false);
    expect(deviationExceeds(26_250_001, 25_000_000)).toBe(true);
    expect(deviationExceeds(23_749_999, 25_000_000)).toBe(true);
    expect(deviationExceeds(25_000_000, 25_000_000)).toBe(false);
  });

  test("[FOR-010] bez platné reference se neupozorňuje", () => {
    expect(deviationExceeds(30_000_000, 0)).toBe(false);
  });
});

describe("očekávaný lístek", () => {
  test("[FOR-003] sobota 31. 10. 2026 má lístek z pátku 30. 10.", () => {
    expect(expectedListDate("2026-10-31", new Date("2026-11-01T10:00:00Z"))).toBe("2026-10-30");
    expect(expectedListDate("2026-11-01", new Date("2026-11-01T10:00:00Z"))).toBe("2026-10-30");
  });

  test("[FOR-003] 28. 10. 2026 je svátek a očekávaný lístek je 27. 10.", () => {
    expect(expectedListDate("2026-10-28", new Date("2026-11-02T10:00:00Z"))).toBe("2026-10-27");
  });

  test("[FOR-003] pondělí 2. 11. 2026 v 10:00 používá lístek z pátku, ve 14:31 očekává pondělní", () => {
    const monday = "2026-11-02";
    expect(expectedListDate(monday, new Date("2026-11-02T09:00:00Z"))).toBe("2026-10-30");
    expect(expectedListDate(monday, new Date("2026-11-02T13:29:00Z"))).toBe("2026-10-30");
    expect(expectedListDate(monday, new Date("2026-11-02T13:30:00Z"))).toBe("2026-11-02");
    expect(expectedListDate(monday, new Date("2026-11-02T13:31:00Z"))).toBe("2026-11-02");
  });

  test("[FOR-003] den se bere v Praze: 31. 10. 2026 23:30 UTC je už 1. 11.", () => {
    expect(expectedListDate("2026-11-01", new Date("2026-10-31T23:30:00Z"))).toBe("2026-10-30");
    const midnight = new Date("2026-11-01T23:30:00Z");
    expect(expectedListDate("2026-11-02", midnight)).toBe("2026-10-30");
    expect(expectedListDate("2026-11-03", midnight)).toBe("2026-11-03");
  });

  test("[FOR-003] dřívější den před 14:30 nečeká na dnešní lístek", () => {
    expect(expectedListDate("2026-10-30", new Date("2026-11-02T09:00:00Z"))).toBe("2026-10-30");
  });
});

describe("rozhodný den", () => {
  const row = { issueDate: "2026-10-20", taxableDate: "2026-10-15" };

  test("[FOR-009] základ DUZP použije DUZP a bez něj datum vystavení", () => {
    expect(rateDate(row, "taxable_date", "2026-11-01")).toBe("2026-10-15");
    expect(rateDate({ ...row, taxableDate: null }, "taxable_date", "2026-11-01")).toBe(
      "2026-10-20",
    );
  });

  test("[FOR-009] základ datum vystavení ignoruje DUZP a bez data platí dnešek", () => {
    expect(rateDate(row, "issue_date", "2026-11-01")).toBe("2026-10-20");
    expect(rateDate({ issueDate: null, taxableDate: null }, "issue_date", "2026-11-01")).toBe(
      "2026-11-01",
    );
    expect(rateDate({ issueDate: null, taxableDate: null }, "taxable_date", "2026-11-01")).toBe(
      "2026-11-01",
    );
  });
});

describe("hodnota v korunách", () => {
  test("[FOR-008] doklad 1 000,00 EUR při 25,000000 je 25 000,00 Kč, oprava -100,00 je -2 500,00 Kč", () => {
    const eur = { currency: "EUR", exchangeRateMicros: 25_000_000 };
    expect(documentCzkMinor({ ...eur, totalMinor: 100_000 })).toBe(2_500_000);
    expect(documentCzkMinor({ ...eur, totalMinor: -10_000 })).toBe(-250_000);
  });

  test("[FOR-008] koruny se nepřepočítají a bez kurzu je hodnota neznámá", () => {
    expect(documentCzkMinor({ currency: "CZK", totalMinor: 5_000, exchangeRateMicros: null })).toBe(
      5_000,
    );
    expect(
      documentCzkMinor({ currency: "EUR", totalMinor: 5_000, exchangeRateMicros: null }),
    ).toBeNull();
  });

  test("[FOR-008] platba se přepočte svým kurzem a bez kurzu je neznámá", () => {
    expect(paymentCzkMinor({ currency: "USD", amountMinor: 10_000, rateMicros: 22_311_000 })).toBe(
      223_110,
    );
    expect(paymentCzkMinor({ currency: "USD", amountMinor: 10_000, rateMicros: null })).toBeNull();
    expect(paymentCzkMinor({ currency: "CZK", amountMinor: 700, rateMicros: null })).toBe(700);
    expect(paymentCzkMinor({ currency: "CZK", amountMinor: -700, rateMicros: 1_000_000 })).toBe(
      -700,
    );
  });
});
