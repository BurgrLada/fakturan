import { isMainThread } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
import {
  ISSUE_RULES,
  nextOccurrences,
  occurrencesBetween,
  RECURRENCE_FREQUENCIES,
  validateRule,
  type RecurrenceRule,
} from "@/lib/recurrence";
import { renderVariables, type VariablePeriod } from "@/lib/template-vars";

function rule(overrides: Partial<RecurrenceRule> = {}): RecurrenceRule {
  return {
    frequency: "monthly",
    every: 1,
    issueRule: "day",
    issueDay: 1,
    startsOn: "2026-01-01",
    endsOn: null,
    maxCount: null,
    periodOffset: 0,
    ...overrides,
  };
}

const dates = (r: RecurrenceRule, count: number, after: string | null = null) =>
  nextOccurrences(r, after, count).map((occurrence) => occurrence.issueDate);
const first = (r: RecurrenceRule) => nextOccurrences(r, null, 1)[0]!;

function render(text: string, period: VariablePeriod, language: "cs" | "en" = "cs") {
  return renderVariables(text, {
    period,
    language,
    dateFormat: "d. M. yyyy",
    number: "",
    customer: "",
  });
}

describe("četnosti", () => {
  test("seznamy četností a pravidel", () => {
    expect(RECURRENCE_FREQUENCIES).toEqual([
      "weekly",
      "monthly",
      "quarterly",
      "half_yearly",
      "yearly",
      "every_weeks",
      "every_months",
    ]);
    expect(ISSUE_RULES).toEqual(["day", "period_end", "first_working_day", "last_working_day"]);
  });

  test.each<[string, Partial<RecurrenceRule>, string[]]>([
    [
      "weekly",
      { frequency: "weekly", issueDay: 3, startsOn: "2026-03-04" },
      ["2026-03-04", "2026-03-11", "2026-03-18", "2026-03-25", "2026-04-01", "2026-04-08"],
    ],
    [
      "monthly",
      { frequency: "monthly", issueDay: 15 },
      ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15", "2026-06-15"],
    ],
    [
      "quarterly",
      { frequency: "quarterly", issueDay: 1 },
      ["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01", "2027-04-01"],
    ],
    [
      "half_yearly",
      { frequency: "half_yearly", issueDay: 10 },
      ["2026-01-10", "2026-07-10", "2027-01-10", "2027-07-10", "2028-01-10", "2028-07-10"],
    ],
    [
      "yearly",
      { frequency: "yearly", issueDay: 20, startsOn: "2026-01-05" },
      ["2026-01-20", "2027-01-20", "2028-01-20", "2029-01-20", "2030-01-20", "2031-01-20"],
    ],
    [
      "every_weeks",
      { frequency: "every_weeks", every: 2, issueDay: 1, startsOn: "2026-03-04" },
      ["2026-03-09", "2026-03-23", "2026-04-06", "2026-04-20", "2026-05-04", "2026-05-18"],
    ],
    [
      "every_months",
      { frequency: "every_months", every: 2, issueDay: 5, startsOn: "2026-11-20" },
      ["2026-12-05", "2027-02-05", "2027-04-05", "2027-06-05", "2027-08-05", "2027-10-05"],
    ],
  ])("[REC-001] %s dá očekávaných 6 termínů", (_name, overrides, expected) => {
    expect(dates(rule(overrides), 6)).toEqual(expected);
  });

  test.each<[string, Partial<RecurrenceRule>, VariablePeriod]>([
    ["měsíc", {}, { from: "2026-01-01", to: "2026-01-31" }],
    [
      "druhé čtvrtletí",
      { frequency: "quarterly", startsOn: "2026-05-01", issueDay: 1 },
      { from: "2026-04-01", to: "2026-06-30" },
    ],
    [
      "první pololetí",
      { frequency: "half_yearly", startsOn: "2026-03-01", issueDay: 1 },
      { from: "2026-01-01", to: "2026-06-30" },
    ],
    [
      "druhé pololetí",
      { frequency: "half_yearly", startsOn: "2026-08-01", issueDay: 1 },
      { from: "2026-07-01", to: "2026-12-31" },
    ],
    [
      "kalendářní rok",
      { frequency: "yearly", startsOn: "2026-06-01", issueDay: 1 },
      { from: "2026-01-01", to: "2026-12-31" },
    ],
    [
      "týden od pondělí do neděle",
      { frequency: "weekly", startsOn: "2026-03-04", issueDay: 3 },
      { from: "2026-03-02", to: "2026-03-08" },
    ],
    [
      "neděle patří do týdne, který jí končí",
      { frequency: "weekly", startsOn: "2026-03-01", issueDay: 7 },
      { from: "2026-02-23", to: "2026-03-01" },
    ],
    [
      "pondělí začíná svůj týden",
      { frequency: "weekly", startsOn: "2026-03-02", issueDay: 1 },
      { from: "2026-03-02", to: "2026-03-08" },
    ],
    [
      "blok tří týdnů od týdne začátku",
      { frequency: "every_weeks", every: 3, startsOn: "2026-03-04", issueDay: 7 },
      { from: "2026-03-02", to: "2026-03-22" },
    ],
    [
      "blok pěti měsíců od měsíce začátku přes rok",
      { frequency: "every_months", every: 5, startsOn: "2026-10-01", issueDay: 1 },
      { from: "2026-10-01", to: "2027-02-28" },
    ],
  ])("[REC-001] období: %s", (_name, overrides, period) => {
    const occurrence = first(rule(overrides));
    expect(occurrence.schedulePeriod).toEqual(period);
    expect(occurrence.periodKey).toBe(period.from);
  });

  test("[REC-001] každých N měsíců nesrovnává blok na kalendářní čtvrtletí", () => {
    const r = rule({ frequency: "every_months", every: 3, startsOn: "2026-02-01" });
    expect(dates(r, 3)).toEqual(["2026-02-01", "2026-05-01", "2026-08-01"]);
    expect(first(r).schedulePeriod.to).toBe("2026-04-30");
  });

  test("[REC-001] každých 12 měsíců se liší od ročního kalendářního období", () => {
    const r = rule({ frequency: "every_months", every: 12, startsOn: "2026-02-10", issueDay: 15 });
    expect(dates(r, 2)).toEqual(["2026-02-15", "2027-02-15"]);
    expect(first(r).schedulePeriod).toEqual({ from: "2026-02-01", to: "2027-01-31" });
  });
});

describe("den vystavení", () => {
  test("[REC-002] 31. v únoru je poslední únorový den, v přestupném 29.", () => {
    expect(dates(rule({ issueDay: 31 }), 4)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(dates(rule({ issueDay: 31, startsOn: "2028-02-01" }), 1)).toEqual(["2028-02-29"]);
  });

  test("[REC-002] konkrétní den čtvrtletí leží v prvním měsíci", () => {
    const r = rule({ frequency: "quarterly", issueDay: 31 });
    expect(dates(r, 4)).toEqual(["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"]);
  });

  test("[REC-002] konkrétní den týdne se počítá od pondělí", () => {
    const r = rule({ frequency: "every_weeks", every: 2, issueDay: 5, startsOn: "2026-03-02" });
    expect(dates(r, 2)).toEqual(["2026-03-06", "2026-03-20"]);
  });

  test("[REC-002] poslední den čtvrtletí, první a poslední pracovní den", () => {
    const quarterly = { frequency: "quarterly", issueDay: null } as const;
    expect(dates(rule({ ...quarterly, issueRule: "period_end" }), 4)).toEqual([
      "2026-03-31",
      "2026-06-30",
      "2026-09-30",
      "2026-12-31",
    ]);
    expect(dates(rule({ issueRule: "first_working_day", issueDay: null }), 8)).toEqual([
      "2026-01-02",
      "2026-02-02",
      "2026-03-02",
      "2026-04-01",
      "2026-05-04",
      "2026-06-01",
      "2026-07-01",
      "2026-08-03",
    ]);
    expect(dates(rule({ issueRule: "last_working_day", issueDay: null }), 5)).toEqual([
      "2026-01-30",
      "2026-02-27",
      "2026-03-31",
      "2026-04-30",
      "2026-05-29",
    ]);
  });

  test("[REC-002] poslední den období platí i o víkendu a svátku", () => {
    const r = rule({ issueRule: "period_end", issueDay: null });
    expect(dates(r, 2)).toEqual(["2026-01-31", "2026-02-28"]);
    expect(dates({ ...r, startsOn: "2026-12-01" }, 1)).toEqual(["2026-12-31"]);
  });

  test("[REC-002] první pracovní den ledna přeskočí Nový rok a víkend", () => {
    const r = rule({
      frequency: "yearly",
      issueRule: "first_working_day",
      issueDay: null,
      startsOn: "2027-01-01",
    });
    expect(dates(r, 2)).toEqual(["2027-01-04", "2028-01-03"]);
  });

  test("[REC-002] Velikonoce posouvají pracovní den přes víkend i hranici měsíce", () => {
    const base = { issueDay: null, startsOn: "2024-03-01" } as const;
    expect(dates(rule({ ...base, issueRule: "last_working_day" }), 1)).toEqual(["2024-03-28"]);
    expect(dates(rule({ ...base, issueRule: "first_working_day" }), 2)[1]).toBe("2024-04-02");
  });

  test("[REC-002] týden s Vánocemi a Velikonocemi", () => {
    const weekly = { frequency: "weekly", issueDay: null } as const;
    expect(
      dates(rule({ ...weekly, issueRule: "last_working_day", startsOn: "2026-12-21" }), 1),
    ).toEqual(["2026-12-23"]);
    expect(
      dates(rule({ ...weekly, issueRule: "first_working_day", startsOn: "2026-04-06" }), 1),
    ).toEqual(["2026-04-07"]);
    expect(
      dates(rule({ ...weekly, issueRule: "last_working_day", startsOn: "2026-03-30" }), 1),
    ).toEqual(["2026-04-02"]);
  });
});

describe("kotvení na začátek plánu", () => {
  const anchored = { startsOn: "2026-02-14", issueDay: 20 };

  test("[REC-002] ročně od 14. 2. s dnem 20 vystaví 20. 2. a období zůstane kalendářní", () => {
    const list = nextOccurrences(rule({ ...anchored, frequency: "yearly" }), null, 2);
    expect(list.map((o) => o.issueDate)).toEqual(["2026-02-20", "2027-02-20"]);
    expect(list.map((o) => o.periodKey)).toEqual(["2026-01-01", "2027-01-01"]);
    expect(list[0]!.schedulePeriod).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  test("[REC-002] čtvrtletně od 14. 2. drží druhý měsíc období", () => {
    const r = rule({ ...anchored, frequency: "quarterly" });
    expect(dates(r, 4)).toEqual(["2026-02-20", "2026-05-20", "2026-08-20", "2026-11-20"]);
    expect(first(r).schedulePeriod).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  test("[REC-002] ročně od 25. 2. je první datum v březnu", () => {
    const r = rule({ frequency: "yearly", issueDay: 20, startsOn: "2026-02-25" });
    expect(dates(r, 2)).toEqual(["2026-03-20", "2027-03-20"]);
  });

  test("[REC-002] datum v den začátku se počítá", () => {
    const r = rule({ frequency: "yearly", issueDay: 20, startsOn: "2026-02-20" });
    expect(dates(r, 1)).toEqual(["2026-02-20"]);
  });

  test("[REC-002] když datum vypadne z období, platí první měsíc dalšího", () => {
    const start = { issueDay: 20, startsOn: "2026-12-25" };
    expect(dates(rule({ ...start, frequency: "yearly" }), 2)).toEqual(["2027-01-20", "2028-01-20"]);
    expect(dates(rule({ ...start, frequency: "quarterly" }), 2)).toEqual([
      "2027-01-20",
      "2027-04-20",
    ]);
  });

  test("[REC-002] začátek na začátku období nic nemění", () => {
    expect(dates(rule({ frequency: "yearly", issueDay: 20 }), 1)).toEqual(["2026-01-20"]);
    const r = rule({ frequency: "quarterly", issueDay: 15, startsOn: "2026-04-01" });
    expect(dates(r, 2)).toEqual(["2026-04-15", "2026-07-15"]);
  });

  test("[REC-002] oříznutí na konec měsíce se počítá jako datum dne", () => {
    const r = rule({ frequency: "half_yearly", issueDay: 31, startsOn: "2026-02-14" });
    expect(dates(r, 5)).toEqual([
      "2026-02-28",
      "2026-08-31",
      "2027-02-28",
      "2027-08-31",
      "2028-02-29",
    ]);
  });

  test("[REC-002] bloky měsíců a týdnů se kotví stejně", () => {
    const months = rule({
      frequency: "every_months",
      every: 3,
      issueDay: 5,
      startsOn: "2026-02-20",
    });
    expect(dates(months, 3)).toEqual(["2026-03-05", "2026-06-05", "2026-09-05"]);
    expect(first(months).schedulePeriod).toEqual({ from: "2026-02-01", to: "2026-04-30" });
    const weeks = rule({
      frequency: "every_weeks",
      every: 2,
      issueRule: "first_working_day",
      issueDay: null,
      startsOn: "2026-03-04",
    });
    expect(dates(weeks, 2)).toEqual(["2026-03-09", "2026-03-23"]);
  });

  test("[REC-002] první pracovní den se kotví na první měsíc, jehož den neprošel", () => {
    const working = { issueRule: "first_working_day", issueDay: null } as const;
    const from = (frequency: RecurrenceRule["frequency"], startsOn: string) =>
      rule({ ...working, frequency, startsOn });
    expect(dates(from("yearly", "2026-02-14"), 3)).toEqual([
      "2026-03-02",
      "2027-03-01",
      "2028-03-01",
    ]);
    expect(dates(from("quarterly", "2026-02-14"), 4)).toEqual([
      "2026-03-02",
      "2026-06-01",
      "2026-09-01",
      "2026-12-01",
    ]);
    expect(dates(from("yearly", "2026-02-02"), 1)).toEqual(["2026-02-02"]);
    expect(dates(from("yearly", "2026-01-01"), 1)).toEqual(["2026-01-02"]);
    expect(dates(from("quarterly", "2026-12-14"), 2)).toEqual(["2027-01-04", "2027-04-01"]);
  });

  test("[REC-002] poslední pracovní den zůstává poslední v období", () => {
    const working = { issueRule: "last_working_day", issueDay: null } as const;
    const from = (frequency: RecurrenceRule["frequency"], startsOn: string) =>
      rule({ ...working, frequency, startsOn });
    expect(dates(from("yearly", "2026-02-14"), 2)).toEqual(["2026-12-31", "2027-12-31"]);
    expect(dates(from("yearly", "2026-01-01"), 1)).toEqual(["2026-12-31"]);
    expect(dates(from("quarterly", "2026-02-14"), 2)).toEqual(["2026-03-31", "2026-06-30"]);
    expect(dates(from("monthly", "2026-01-31"), 1)).toEqual(["2026-02-27"]);
  });
});

describe("začátek a konec", () => {
  test("[REC-003] konec datem a počtem, bez konce", () => {
    expect(dates(rule({ endsOn: "2026-04-01" }), 10)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
    expect(dates(rule({ endsOn: "2026-03-31" }), 10)).toHaveLength(3);
    expect(dates(rule({ maxCount: 3 }), 10)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(dates(rule(), 24)).toHaveLength(24);
    expect(dates(rule(), 24)[23]).toBe("2027-12-01");
  });

  test("[REC-003] termín v den začátku platí, před ním ne a počet se o něj nezkrátí", () => {
    expect(dates(rule({ startsOn: "2026-01-01" }), 1)).toEqual(["2026-01-01"]);
    const late = rule({ startsOn: "2026-01-02", maxCount: 2 });
    expect(nextOccurrences(late, null, 5).map((o) => [o.index, o.issueDate])).toEqual([
      [0, "2026-02-01"],
      [1, "2026-03-01"],
    ]);
  });

  test("[REC-003] počet platí i při pokračování od kurzoru", () => {
    const r = rule({ maxCount: 3 });
    expect(nextOccurrences(r, "2026-02-15", 10).map((o) => [o.index, o.issueDate])).toEqual([
      [2, "2026-03-01"],
    ]);
    expect(nextOccurrences(r, "2026-03-01", 10)).toEqual([]);
  });

  test("[REC-003] oba konce: rozhodne dřívější", () => {
    expect(dates(rule({ maxCount: 2, endsOn: "2026-12-31" }), 10)).toHaveLength(2);
    expect(dates(rule({ maxCount: 12, endsOn: "2026-02-01" }), 10)).toHaveLength(2);
  });

  test("occurrencesBetween vrací termíny za after až do through včetně", () => {
    const list = (after: string | null, through: string) =>
      occurrencesBetween(rule(), after, through).map((o) => o.issueDate);
    expect(list(null, "2026-03-01")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(list(null, "2026-02-28")).toEqual(["2026-01-01", "2026-02-01"]);
    expect(list("2026-01-01", "2026-03-01")).toEqual(["2026-02-01", "2026-03-01"]);
    expect(list("2026-01-31", "2026-02-01")).toEqual(["2026-02-01"]);
    expect(list("2026-03-01", "2026-03-01")).toEqual([]);
    expect(list(null, "2025-12-31")).toEqual([]);
  });

  test("occurrencesBetween zachová pořadové číslo od začátku plánu", () => {
    expect(occurrencesBetween(rule(), "2026-02-01", "2026-03-01")[0]!.index).toBe(2);
  });

  test("nextOccurrences s nulovým počtem nevrátí nic", () => {
    expect(nextOccurrences(rule(), null, 0)).toEqual([]);
  });

  test("neplatné pravidlo se nepočítá, jinak by cyklus neskončil", () => {
    expect(() => nextOccurrences(rule({ every: 0, issueDay: 0 }), null, 1)).toThrow(
      "Invalid recurrence rule: every, issueDay",
    );
    expect(() => occurrencesBetween(rule({ every: 0 }), null, "2026-12-31")).toThrow();
  });
});

// Worker threads get a copy of process.env, so TZ only takes effect in a forked runner, not under Stryker.
describe.skipIf(!isMainThread)("časové pásmo", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  test("[REC-006] období se počítá z kalendářních dat bez závislosti na TZ procesu", () => {
    for (const zone of ["UTC", "America/New_York", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
      const weekly = rule({ frequency: "weekly", issueDay: 7, startsOn: "2026-03-23" });
      expect(dates(weekly, 2)).toEqual(["2026-03-29", "2026-04-05"]);
      expect(first(weekly).schedulePeriod).toEqual({ from: "2026-03-23", to: "2026-03-29" });
      const firstWorking = rule({ issueRule: "first_working_day", issueDay: null });
      expect(dates(firstWorking, 1)).toEqual(["2026-01-02"]);
    }
  });
});

describe("posun období a proměnné", () => {
  test("[REC-020] faktura za {{ctvrtleti}}. čtvrtletí {{rok}} dá 3. čtvrtletí 2026", () => {
    const r = rule({ frequency: "quarterly", startsOn: "2026-07-01" });
    expect(render("faktura za {{ctvrtleti}}. čtvrtletí {{rok}}", first(r).billedPeriod)).toBe(
      "faktura za 3. čtvrtletí 2026",
    );
  });

  test("[REC-021] vystavení 1. 10. s posunem -1 fakturuje 3. čtvrtletí", () => {
    const r = rule({ frequency: "quarterly", startsOn: "2026-10-01", periodOffset: -1 });
    const occurrence = first(r);
    expect(occurrence.issueDate).toBe("2026-10-01");
    expect(occurrence.schedulePeriod).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(occurrence.billedPeriod).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(occurrence.periodKey).toBe("2026-10-01");
    expect(render("{{ctvrtleti}}. čtvrtletí {{rok}}", occurrence.billedPeriod)).toBe(
      "3. čtvrtletí 2026",
    );
  });

  test.each<[string, Partial<RecurrenceRule>, VariablePeriod]>([
    [
      "čtvrtletí zpět",
      { frequency: "quarterly", periodOffset: -1 },
      { from: "2025-10-01", to: "2025-12-31" },
    ],
    [
      "čtvrtletí vpřed",
      { frequency: "quarterly", startsOn: "2026-10-01", periodOffset: 1 },
      { from: "2027-01-01", to: "2027-03-31" },
    ],
    ["12 měsíců zpět", { periodOffset: -12 }, { from: "2025-01-01", to: "2025-01-31" }],
    ["12 měsíců vpřed", { periodOffset: 12 }, { from: "2027-01-01", to: "2027-01-31" }],
    [
      "týden zpět",
      { frequency: "weekly", startsOn: "2026-01-01", issueDay: 7, periodOffset: -1 },
      { from: "2025-12-22", to: "2025-12-28" },
    ],
    [
      "pololetí zpět",
      { frequency: "half_yearly", startsOn: "2026-07-01", periodOffset: -1 },
      { from: "2026-01-01", to: "2026-06-30" },
    ],
    [
      "rok zpět",
      { frequency: "yearly", periodOffset: -1 },
      { from: "2025-01-01", to: "2025-12-31" },
    ],
    [
      "blok měsíců zpět",
      { frequency: "every_months", every: 2, periodOffset: -1 },
      { from: "2025-11-01", to: "2025-12-31" },
    ],
    [
      "blok týdnů vpřed",
      { frequency: "every_weeks", every: 2, startsOn: "2026-03-02", periodOffset: 1 },
      { from: "2026-03-16", to: "2026-03-29" },
    ],
    [
      "blok týdnů zpět",
      { frequency: "every_weeks", every: 2, startsOn: "2026-03-02", periodOffset: -1 },
      { from: "2026-02-16", to: "2026-03-01" },
    ],
  ])("[REC-021] posun přes hranici roku: %s", (_name, overrides, period) => {
    expect(first(rule(overrides)).billedPeriod).toEqual(period);
  });

  test("[REC-021] nulový posun fakturuje plánovací období", () => {
    const occurrence = first(rule());
    expect(occurrence.billedPeriod).toEqual(occurrence.schedulePeriod);
  });

  test("[REC-023] období plyne z termínu v plánu, ne z pozdějšího dne běhu", () => {
    const r = rule({ startsOn: "2026-07-01" });
    const occurrence = occurrencesBetween(r, "2026-06-30", "2026-08-15")[0]!;
    expect(render("{{mesic}}/{{rok}}", occurrence.billedPeriod)).toBe("7/2026");
    expect(render("{{obdobi_od}} až {{obdobi_do}}", occurrence.billedPeriod)).toBe(
      "1. 7. 2026 až 31. 7. 2026",
    );
  });

  test("[REC-024] název měsíce ve fakturovaném období se řídí jazykem", () => {
    const { billedPeriod } = first(rule({ startsOn: "2026-07-01", periodOffset: -1 }));
    expect(render("{{mesic_nazev}}", billedPeriod, "cs")).toBe("červen");
    expect(render("{{mesic_nazev}}", billedPeriod, "en")).toBe("June");
  });
});

describe("kalendářní hrany", () => {
  test("[TST-007] přelom roku, čtvrtletí, 31. den a týden s přechodem času", () => {
    expect(dates(rule({ startsOn: "2026-11-01", issueDay: 31 }), 4)).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
    const quarterEnd = rule({
      frequency: "quarterly",
      issueRule: "period_end",
      issueDay: null,
      startsOn: "2026-10-01",
    });
    expect(dates(quarterEnd, 2)).toEqual(["2026-12-31", "2027-03-31"]);
    const spring = rule({ frequency: "weekly", issueDay: 7, startsOn: "2026-03-23" });
    expect(dates(spring, 2)).toEqual(["2026-03-29", "2026-04-05"]);
    const autumn = rule({ frequency: "weekly", issueDay: 7, startsOn: "2026-10-19" });
    expect(dates(autumn, 2)).toEqual(["2026-10-25", "2026-11-01"]);
    const autumnPeriod = rule({ frequency: "weekly", issueDay: 1, startsOn: "2026-10-26" });
    expect(first(autumnPeriod).schedulePeriod).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });
});

describe("validateRule", () => {
  test("platná pravidla projdou", () => {
    for (const r of [
      rule(),
      rule({ frequency: "weekly", issueDay: 1 }),
      rule({ frequency: "weekly", issueDay: 7 }),
      rule({ issueDay: 31 }),
      rule({ frequency: "every_weeks", every: 1 }),
      rule({ frequency: "every_weeks", every: 52 }),
      rule({ frequency: "every_months", every: 24 }),
      rule({ issueRule: "period_end", issueDay: null }),
      rule({ issueRule: "first_working_day", issueDay: null }),
      rule({ issueRule: "last_working_day", issueDay: null }),
      rule({ periodOffset: -12 }),
      rule({ periodOffset: 12 }),
      rule({ endsOn: "2026-01-01" }),
      rule({ maxCount: 1 }),
      rule({ startsOn: "2100-12-01", endsOn: "2100-12-31" }),
      rule({ startsOn: "2026-01-15", endsOn: "2026-02-01" }),
      rule({ frequency: "yearly", startsOn: "2026-02-14", issueDay: 20, endsOn: "2026-02-20" }),
    ]) {
      expect(validateRule(r)).toEqual([]);
    }
  });

  test.each<[string, Partial<RecurrenceRule>]>([
    ["frequency", { frequency: "daily" as RecurrenceRule["frequency"] }],
    ["every", { every: 0 }],
    ["every", { every: 2 }],
    ["every", { frequency: "yearly", every: 2 }],
    ["every", { frequency: "weekly", every: 2 }],
    ["every", { frequency: "every_weeks", every: 0 }],
    ["every", { frequency: "every_weeks", every: 53 }],
    ["every", { frequency: "every_weeks", every: 1.5 }],
    ["every", { frequency: "every_months", every: 0 }],
    ["every", { frequency: "every_months", every: 25 }],
    ["issueRule", { issueRule: "never" as RecurrenceRule["issueRule"], issueDay: null }],
    ["issueDay", { issueDay: 0 }],
    ["issueDay", { issueDay: 32 }],
    ["issueDay", { issueDay: 1.5 }],
    ["issueDay", { issueDay: null }],
    ["issueDay", { frequency: "weekly", issueDay: 0 }],
    ["issueDay", { frequency: "weekly", issueDay: 8 }],
    ["issueDay", { frequency: "every_weeks", issueDay: 8 }],
    ["issueDay", { issueRule: "period_end", issueDay: 1 }],
    ["issueDay", { issueRule: "first_working_day", issueDay: 1 }],
    ["startsOn", { startsOn: "2026-02-30" }],
    ["endsOn", { endsOn: "nikdy" }],
    ["endsOn", { endsOn: "2025-12-31" }],
    ["startsOn", { startsOn: "9999-12-20" }],
    ["startsOn", { startsOn: "2101-01-01" }],
    ["endsOn", { endsOn: "9999-12-20" }],
    ["endsOn", { endsOn: "2101-01-01" }],
    ["endsOn", { startsOn: "2026-01-15", endsOn: "2026-01-31" }],
    ["endsOn", { frequency: "yearly", startsOn: "2026-02-14", issueDay: 20, endsOn: "2026-02-19" }],
    ["maxCount", { maxCount: 0 }],
    ["maxCount", { maxCount: 1.5 }],
    ["periodOffset", { periodOffset: -13 }],
    ["periodOffset", { periodOffset: 13 }],
    ["periodOffset", { periodOffset: 0.5 }],
  ])("vrátí vadné pole %s: %j", (field, overrides) => {
    expect(validateRule(rule(overrides))).toEqual([field]);
  });

  test("první termín za koncem se u neplatného pravidla nepočítá", () => {
    expect(validateRule(rule({ every: 0, endsOn: "2026-01-01" }))).toEqual(["every"]);
    expect(validateRule(rule({ every: 0, endsOn: "2025-12-31" }))).toEqual(["every", "endsOn"]);
    expect(validateRule(rule({ startsOn: "9999-12-20", endsOn: "9999-12-31" }))).toEqual([
      "startsOn",
      "endsOn",
    ]);
  });

  test("datum mimo rozsah se nepočítá, smyčka by přes rok 9999 neskončila", () => {
    expect(() => nextOccurrences(rule({ startsOn: "9999-12-20" }), null, 3)).toThrow(
      "Invalid recurrence rule: startsOn",
    );
  });

  test("vrátí všechna vadná pole", () => {
    expect(validateRule(rule({ every: 0, issueDay: 0, maxCount: 0 }))).toEqual([
      "every",
      "issueDay",
      "maxCount",
    ]);
  });
});
