import Database from "better-sqlite3";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { documentCzkMinor, toCzkMinor } from "@/lib/fx";
import { registerSqlFunctions } from "@/lib/sql-functions";

const sqlite = new Database(":memory:");
registerSqlFunctions(sqlite);
afterAll(() => sqlite.close());

const one = (query: string, ...params: unknown[]) =>
  sqlite
    .prepare(query)
    .pluck()
    .get(...params);

function median(values: (number | null)[]): unknown {
  sqlite.exec("DROP TABLE IF EXISTS v; CREATE TABLE v (x)");
  const insert = sqlite.prepare("INSERT INTO v (x) VALUES (?)");
  for (const value of values) insert.run(value);
  return one("SELECT median_minor(x) FROM v");
}

describe("fx_czk", () => {
  test("fx_czk dává pro libovolnou částku a kurz totéž co toCzkMinor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -99_999_999_999, max: 99_999_999_999 }),
        fc.integer({ min: 1, max: 1_000_000_000_000 }),
        (amount, rate) => {
          let expected: number | null;
          try {
            expected = toCzkMinor(amount, rate);
          } catch {
            expected = null;
          }
          expect(one("SELECT fx_czk('EUR', ?, ?)", amount, rate)).toBe(expected);
        },
      ),
    );
  });

  test("[REP-009] -1 234,56 EUR při 25,320000 dá -31 259,06 Kč v SQL i v documentCzkMinor", () => {
    expect(one("SELECT fx_czk('EUR', -123456, 25320000)")).toBe(-3_125_906);
    expect(
      documentCzkMinor({ currency: "EUR", totalMinor: -123_456, exchangeRateMicros: 25_320_000 }),
    ).toBe(-3_125_906);
    expect(one("SELECT typeof(fx_czk('EUR', -123456, 25320000))")).toBe("integer");
  });

  test("CZK se nepřevádí a cizí měna bez kurzu je NULL", () => {
    expect(one("SELECT fx_czk('CZK', 12345, NULL)")).toBe(12_345);
    expect(one("SELECT fx_czk('CZK', 12345, 25000000)")).toBe(12_345);
    expect(one("SELECT fx_czk('EUR', 12345, NULL)")).toBeNull();
  });

  test("vadný vstup fx_czk vrátí NULL a nesrazí dotaz", () => {
    expect(one("SELECT fx_czk('EUR', 1.5, 25000000)")).toBeNull();
    expect(one("SELECT fx_czk('EUR', '100', 25000000)")).toBeNull();
    expect(one("SELECT fx_czk('EUR', 100, 0)")).toBeNull();
    expect(one("SELECT fx_czk('EUR', 100, -1)")).toBeNull();
    expect(one("SELECT fx_czk('EUR', 100, 2.5)")).toBeNull();
    expect(one("SELECT fx_czk(NULL, 100, 25000000)")).toBeNull();
    expect(one("SELECT fx_czk('CZK', NULL, NULL)")).toBeNull();
    expect(one("SELECT fx_czk('EUR', 9007199254740991, 1000000000000)")).toBeNull();
    expect(
      one(
        "SELECT sum(fx_czk(c, a, r)) FROM (SELECT 'EUR' c, 'x' a, 1 r UNION ALL SELECT 'CZK', 5, NULL)",
      ),
    ).toBe(5);
  });
});

describe("date_bucket a prague_date", () => {
  test("koš data odpovídá bucketKey a vadný vstup je NULL", () => {
    expect(one("SELECT date_bucket('2027-01-01', 'week')")).toBe("2026-W53");
    expect(one("SELECT date_bucket('2026-05-12', 'month')")).toBe("2026-05");
    expect(one("SELECT date_bucket('2026-05-12', 'quarter')")).toBe("2026-Q2");
    expect(one("SELECT date_bucket('2026-02-30', 'day')")).toBeNull();
    expect(one("SELECT date_bucket('2026-05-12', 'hour')")).toBeNull();
    expect(one("SELECT date_bucket(NULL, 'day')")).toBeNull();
    expect(one("SELECT date_bucket(20260512, 'day')")).toBeNull();
  });

  test("pražské datum z milisekund a vadný vstup je NULL", () => {
    expect(one("SELECT prague_date(?)", Date.UTC(2026, 9, 31, 23, 30))).toBe("2026-11-01");
    expect(one("SELECT prague_date(?)", Date.UTC(2026, 6, 31, 21, 59))).toBe("2026-07-31");
    expect(one("SELECT prague_date(?)", Date.UTC(2026, 6, 31, 22, 0))).toBe("2026-08-01");
    expect(one("SELECT prague_date('x')")).toBeNull();
    expect(one("SELECT prague_date(NULL)")).toBeNull();
    expect(one("SELECT prague_date(1e300)")).toBeNull();
  });
});

describe("median_minor", () => {
  test("medián 100, 200, 400, 1 000 je 300 a 0,01 s 0,02 dá 0,02", () => {
    expect(median([10_000, 20_000, 40_000, 100_000])).toBe(30_000);
    expect(median([100_000, 10_000, 40_000, 20_000])).toBe(30_000);
    expect(median([1, 2])).toBe(2);
    expect(median([-1, -2])).toBe(-2);
    expect(median([-1, 2])).toBe(1);
  });

  test("lichý počet vrátí prostřední, prázdno a NULL se přeskočí", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
    expect(median([null, null])).toBeNull();
    expect(median([null, 4, 2])).toBe(3);
    expect(one("SELECT typeof(median_minor(x)) FROM (SELECT 3 x UNION ALL SELECT 4)")).toBe(
      "integer",
    );
  });

  test("vadná hodnota se přeskočí a dotaz nespadne", () => {
    expect(
      one("SELECT median_minor(x) FROM (SELECT 'a' x UNION ALL SELECT 1.5 UNION ALL SELECT 8)"),
    ).toBe(8);
  });
});

describe("czech_key", () => {
  test("text dostane řadicí klíč a jiný vstup NULL", () => {
    expect(typeof one("SELECT czech_key('Čáp')")).toBe("string");
    expect(one("SELECT czech_key(NULL)")).toBeNull();
  });
});
