import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  assertVariantIds,
  AUTO_MATCH_VARIANTS,
  BANK_PARSERS,
  isProvisional,
  parserFor,
} from "@/lib/bank-notices";
import { fioParser } from "@/lib/bank-notices/fio";
import type { BankNoticeParser, NoticeMeta, ParsedNotice } from "@/lib/bank-notices/types";

const FIXTURES = join(import.meta.dirname, "../fixtures/fio");
const SYNTHETIC = "# SYNTETICKÉ: smyšlené údaje sestavené z popisků spec, nejde o reálné avízo";
const FROM_REAL = "# SYNTETICKÉ: smyšlené údaje podle struktury reálného avíza";

const fixture = (name: string, ext = "txt") =>
  readFileSync(join(FIXTURES, `${name}.${ext}`), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");

const meta = (subject: string, from = ["automat@fio.cz"]): NoticeMeta => ({ from, subject });
const EN = meta("Fio banka - new income on account");
const CS = meta("Fio banka - příjem na účtu");

const enBody = (overrides: Record<string, string | null> = {}) =>
  Object.entries({
    Account: "9999999999/2010",
    Amount: "100.00",
    Currency: "CZK",
    Date: "10/30/2026 14:05",
    "Instruction ID": "10000000001",
    ...overrides,
  })
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

type Sentence = {
  account?: string;
  date?: string;
  time?: string;
  verb?: string;
  amount?: string;
  currency?: string;
};

const sentence = (over: Sentence = {}) => {
  const { account, date, time, verb, amount, currency } = {
    account: "9999999999",
    date: "30.10.2026",
    time: "14:05",
    verb: "zvýšil",
    amount: "100,00",
    currency: "CZK",
    ...over,
  };
  return `zůstatek účtu ${account} se ${date} v ${time} ${verb} o ${amount} ${currency}.`;
};

const csFields = (overrides: Record<string, string | null> = {}) =>
  Object.entries({
    "Typ pohybu": "Okamžitá příchozí platba",
    Protistrana: "1111111116/0800 (Ukázková Firma s.r.o.)",
    "ID pokynu": "10000000001",
    ...overrides,
  })
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label}: ${value} `);

const csBody = (overrides: Record<string, string | null> = {}, over: Sentence = {}) =>
  [
    "Dobrý den, ",
    " ",
    sentence(over),
    "",
    "Další parametry",
    ...csFields(overrides),
    "",
    "Aktuální zůstatek: 100,00 CZK",
    "",
    "Fio banka",
  ].join("\n");

const FULL = {
  targetAccount: "9999999999/2010",
  amountMinor: 1_234_560,
  currency: "CZK",
  occurredAt: { date: "2026-10-30", time: "14:05" },
  variableSymbol: "20260042",
  constantSymbol: "0308",
  counterpartyAccount: "1111111116/0800",
} satisfies Partial<ParsedNotice>;

describe("anglická varianta", () => {
  test("[BNK-005] anglická varianta dá všechna pole včetně data m/d/rrrr", () => {
    expect(fioParser.parse(fixture("en-income"), EN)).toEqual({
      ...FULL,
      variant: "en",
      counterpartyName: "Ukazkova Firma s.r.o.",
      message: "Fiktivni platba",
      instructionId: "10000000001",
    });
  });

  test("[BNK-005] volitelná pole chybí a datum může být bez času", () => {
    expect(fioParser.parse(fixture("en-income-minimal"), EN)).toEqual({
      variant: "en",
      targetAccount: "9999999999",
      amountMinor: 50_000,
      currency: "EUR",
      occurredAt: { date: "2026-01-02", time: null },
      variableSymbol: null,
      constantSymbol: null,
      counterpartyAccount: null,
      counterpartyName: null,
      message: null,
      instructionId: "10000000002",
    });
  });

  test("[BNK-005] prázdný volitelný popisek je jako chybějící", () => {
    const parsed = fioParser.parse(
      enBody({
        "Variable symbol": "",
        "Constant symbol": "",
        "Counterparty account": "",
        Counterparty: "",
        Message: "",
      }),
      EN,
    );
    expect(parsed).toMatchObject({
      variableSymbol: null,
      constantSymbol: null,
      counterpartyAccount: null,
      counterpartyName: null,
      message: null,
    });
  });

  test("hodnota smí obsahovat dvojtečku a řádky CRLF", () => {
    const parsed = fioParser.parse(enBody({ Message: "faktura: 42" }).replaceAll("\n", "\r\n"), EN);
    expect(parsed).toMatchObject({ message: "faktura: 42", instructionId: "10000000001" });
  });

  test("účet s předčíslím projde", () => {
    expect(fioParser.parse(enBody({ Account: "19-1234567890/0800" }), EN)?.targetAccount).toBe(
      "19-1234567890/0800",
    );
  });
});

describe("česká varianta", () => {
  test("[BNK-005] česká varianta podle reálného avíza dá všechna pole", () => {
    expect(fioParser.parse(fixture("cs-income"), CS)).toEqual({
      ...FULL,
      targetAccount: "9999999999",
      variant: "cs",
      counterpartyName: "Ukázková Firma s.r.o.",
      message: "Fiktivní platba",
      instructionId: "10000000003",
    });
  });

  test("[BNK-005] nejkratší české avízo bez symbolů, zprávy a jména protistrany", () => {
    expect(fioParser.parse(fixture("cs-income-minimal"), CS)).toEqual({
      variant: "cs",
      targetAccount: "9999999999",
      amountMinor: 100,
      currency: "CZK",
      occurredAt: { date: "2026-01-02", time: "09:30" },
      variableSymbol: null,
      constantSymbol: null,
      counterpartyAccount: "1111111116/2010",
      counterpartyName: null,
      message: null,
      instructionId: "10000000004",
    });
  });

  test("[BNK-005] řádky CRLF a mezery na konci řádků nevadí", () => {
    const body = fixture("cs-income").replaceAll("\n", "\r\n");
    expect(fioParser.parse(body, CS)).toMatchObject({
      instructionId: "10000000003",
      variableSymbol: "20260042",
      message: "Fiktivní platba",
    });
  });

  test("[BNK-005] účet s předčíslím a s kódem banky projde", () => {
    const parsed = fioParser.parse(
      csBody({ Protistrana: "19-1111111116/0800" }, { account: "19-9999999999" }),
      CS,
    );
    expect(parsed).toMatchObject({
      targetAccount: "19-9999999999",
      counterpartyAccount: "19-1111111116/0800",
    });
    expect(fioParser.parse(csBody({}, { account: "9999999999/2010" }), CS)?.targetAccount).toBe(
      "9999999999/2010",
    );
  });

  test("[BNK-005] jméno protistrany smí obsahovat závorky a chybět", () => {
    expect(
      fioParser.parse(csBody({ Protistrana: "1111111116/0800 (Firma (CZ) s.r.o.)" }), CS),
    ).toMatchObject({
      counterpartyAccount: "1111111116/0800",
      counterpartyName: "Firma (CZ) s.r.o.",
    });
    expect(fioParser.parse(csBody({ Protistrana: "1111111116/0800" }), CS)).toMatchObject({
      counterpartyAccount: "1111111116/0800",
      counterpartyName: null,
    });
    expect(fioParser.parse(csBody({ Protistrana: null }), CS)).toMatchObject({
      counterpartyAccount: null,
      counterpartyName: null,
    });
  });

  test("[BNK-005] symboly jsou číslice a uživatelský symbol volný text", () => {
    const parsed = fioParser.parse(
      csBody({
        "Variabilní symbol": "0042",
        "Specifický symbol": "77",
        "Konstantní symbol": "0558",
        "Uživatelský symbol": "Nájem: listopad",
      }),
      CS,
    );
    expect(parsed).toMatchObject({ variableSymbol: "0042", constantSymbol: "0558" });
  });

  test("[BNK-005] mezera za ID pokynu se ořízne", () => {
    expect(fioParser.parse(csBody({ "ID pokynu": "10000000001    " }), CS)?.instructionId).toBe(
      "10000000001",
    );
  });

  test.each([
    ["1 000", 100_000],
    ["14 200,00", 1_420_000],
    ["14\u00A0200,00", 1_420_000],
    ["1,00", 100],
    ["0,01", 1],
  ])("česká částka %s", (amount, minor) => {
    expect(fioParser.parse(csBody({}, { amount }), CS)?.amountMinor).toBe(minor);
  });

  test("datum a čas se čtou z věty, hodina smí být jednociferná", () => {
    expect(fioParser.parse(csBody({}, { date: "3.4.2026", time: "7:05" }), CS)?.occurredAt).toEqual(
      { date: "2026-04-03", time: "07:05" },
    );
    expect(fioParser.parse(csBody({}, { time: "23:59" }), CS)?.occurredAt).toEqual({
      date: "2026-10-30",
      time: "23:59",
    });
  });

  test.each([
    ["30.2.2026", "14:05"],
    ["1.13.2026", "14:05"],
    ["10/30/2026", "14:05"],
    ["30.10.1999", "14:05"],
    ["30.10.26", "14:05"],
    ["30.10.2026", "24:00"],
    ["30.10.2026", "14:60"],
    ["30.10.2026", "14.05"],
  ])("české datum %s %s je nerozpoznané", (date, time) => {
    expect(fioParser.parse(csBody({}, { date, time }), CS)).toBeNull();
  });

  test.each([
    ["snížení zůstatku", { verb: "snížil" }],
    ["tečka v částce", { amount: "1.00" }],
    ["tisíce s tečkou", { amount: "1.234,50" }],
    ["neznámá měna", { currency: "HUF" }],
    ["neplatný účet", { account: "abc" }],
    ["nulová částka", { amount: "0,00" }],
    ["záporná částka", { amount: "-1,00" }],
  ])("věta je nerozpoznaná: %s", (_, over) => {
    expect(fioParser.parse(csBody({}, over), CS)).toBeNull();
  });

  test.each([
    ["druhá věta", (body: string) => `${body}\n${sentence({ amount: "9,00" })}`],
    ["věta chybí", (body: string) => body.replace(sentence(), "")],
    ["slovo před větou", (body: string) => body.replace(sentence(), `x${sentence()}`)],
    ["text za větou", (body: string) => body.replace(sentence(), `${sentence()} navíc`)],
    [
      "věta až za parametry",
      (body: string) => body.replace(sentence(), "").replace("Fio banka", sentence()),
    ],
  ])("avízo je nerozpoznané: %s", (_, change) => {
    expect(fioParser.parse(change(csBody()), CS)).toBeNull();
  });

  test.each([
    ["Protistrana", "abc"],
    ["Protistrana", "1111111116"],
    ["Protistrana", "1111111116/0800 Firma"],
    ["Protistrana", "1111111116/0800 ()"],
    ["Variabilní symbol", "12A"],
    ["Specifický symbol", "x"],
    ["Konstantní symbol", "12345678901"],
    ["ID pokynu", "12 34"],
    ["ID pokynu", ""],
  ])("pochybný údaj %s=%s shodí celé avízo", (label, value) => {
    expect(fioParser.parse(csBody({ [label]: value }), CS)).toBeNull();
  });

  test("povinné ID pokynu nesmí chybět", () => {
    expect(fioParser.parse(csBody({ "ID pokynu": null }), CS)).toBeNull();
  });

  test("opakovaný nebo přeházený popisek je nejistota", () => {
    expect(fioParser.parse(`${csBody()}\nID pokynu: 2`, CS)).toBeNull();
    const fields = csFields({ "Variabilní symbol": "1" });
    const swapped = [sentence(), fields[3], fields[0], fields[1], fields[2]].join("\n");
    expect(fioParser.parse(swapped, CS)).toBeNull();
    expect(fioParser.parse([sentence(), ...fields].join("\n"), CS)).not.toBeNull();
  });

  test("uživatelský symbol přes víc řádků nedoplní variabilní symbol", () => {
    const body = csBody({ "Uživatelský symbol": "x\nVariabilní symbol: 666" });
    expect(fioParser.parse(body, CS)).toBeNull();
  });

  test("zpráva plátce nepřepíše ani nedoplní pole", () => {
    const body = csBody({ "Zpráva pro příjemce": "dik" }).replace(
      "Aktuální zůstatek: 100,00 CZK",
      ["Variabilní symbol: 666", "ID pokynu: 2", sentence({ amount: "99 000,00" })].join("\n"),
    );
    expect(fioParser.parse(body, CS)).toMatchObject({
      message: "dik",
      variableSymbol: null,
      instructionId: "10000000001",
      amountMinor: 10_000,
    });
  });

  test.each([
    `Zpráva pro příjemce: ${sentence({ amount: "99 000,00" })}`,
    `Protistrana: ${sentence({ amount: "99 000,00" })}`,
    `Dobrý den: ${sentence({ amount: "99 000,00" })}`,
    `Text. ${sentence({ amount: "99 000,00" })}`,
  ])("věta podvržená v jiném řádku se nečte: %s", (line) => {
    const body = ["Dobrý den,", line, ...csFields({ Protistrana: null })].join("\n");
    expect(fioParser.parse(body, CS)).toBeNull();
  });

  test("[BNK-012] změněné české avízo dá null", () => {
    expect(fioParser.parse(fixture("cs-changed-format"), CS)).toBeNull();
  });

  test("[BNK-005] česká varianta se páruje automaticky, anglická je prozatímní", () => {
    expect(AUTO_MATCH_VARIANTS).toEqual(["cs"]);
    expect(isProvisional("cs")).toBe(false);
    expect(isProvisional("en")).toBe(true);
    // Stored by the guessed layouts that the real sample replaced.
    expect(isProvisional("cs_block")).toBe(true);
    expect(isProvisional("cs_sentence")).toBe(true);
  });
});

describe("fixtury", () => {
  const files = readdirSync(FIXTURES);

  test("každá fixtura je označená jako syntetická, česká podle reálného avíza", () => {
    expect(files).toHaveLength(9);
    for (const file of files) {
      const lines = readFileSync(join(FIXTURES, file), "utf8").split("\n");
      expect(lines).toContain(file.startsWith("cs-") ? FROM_REAL : SYNTHETIC);
    }
  });

  // TST-006 stays partial: the English layout was never compared with a real notice.
  test("[TST-006] všechny fixtury v obou jazycích", () => {
    const cases: [string, NoticeMeta, "income" | "expense" | "unknown", boolean][] = [
      ["en-income", EN, "income", true],
      ["en-income-minimal", EN, "income", true],
      ["cs-income", CS, "income", true],
      ["cs-income-minimal", CS, "income", true],
      ["en-expense", meta("Fio banka - expense on account"), "expense", false],
      ["cs-expense", meta("Fio banka - výdaj na účtu"), "expense", false],
      ["en-changed-format", EN, "income", false],
      ["cs-changed-format", CS, "income", false],
    ];
    const texts = files.filter((file) => file.endsWith(".txt"));
    expect(cases.map(([name]) => `${name}.txt`).sort()).toEqual(texts.sort());
    for (const [name, noticeMeta, kind, parses] of cases) {
      expect(fioParser.classify(noticeMeta)).toBe(kind);
      expect(fioParser.parse(fixture(name), noticeMeta) !== null).toBe(parses);
    }
  });

  test("[TST-006] výdajové české avízo pod příjmovým předmětem neprojde", () => {
    expect(fioParser.parse(fixture("cs-expense"), CS)).toBeNull();
  });

  test("[TST-006] celá zpráva avíza je jen v quoted-printable fixtuře", () => {
    expect(files.filter((file) => file.endsWith(".eml"))).toEqual(["cs-income.eml"]);
    const raw = fixture("cs-income", "eml");
    expect(raw).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(raw).toContain("From: automat@fio.cz");
    expect(raw).toMatch(/=20$/m);
  });
});

describe("třídění", () => {
  test("[BNK-004] jen přesný odesílatel a dva předměty jdou do parseru", () => {
    expect(fioParser.classify(meta("Fio banka - příjem na kontě"))).toBe("unknown");
    for (const subject of [EN.subject, CS.subject]) {
      expect(fioParser.classify(meta(subject))).toBe("income");
      expect(fioParser.classify(meta(subject, ["AUTOMAT@Fio.CZ"]))).toBe("income");
      expect(fioParser.classify(meta(subject, ["xautomat@fio.cz"]))).toBeNull();
      expect(fioParser.classify(meta(subject, ["automat@fio.cz.evil.com"]))).toBeNull();
      expect(fioParser.classify(meta(subject, ["automat@fio.cz", "a@b.cz"]))).toBeNull();
      expect(fioParser.classify(meta(subject, []))).toBeNull();
    }
  });

  test("[BNK-004] výdajové avízo se ignoruje", () => {
    for (const subject of [
      "Fio banka - výdaj na kontě",
      "Fio banka - VYDAJ na účtu",
      "Fio banka - výdaj na účtu",
      "Fio banka - new expense on account",
      "Fio banka - debit on account",
      "Fio banka - Outgoing payment",
    ]) {
      expect(fioParser.classify(meta(subject))).toBe("expense");
      expect(fioParser.parse(fixture("en-income"), meta(subject))).toBeNull();
    }
    expect(fioParser.parse(fixture("en-income"), meta(EN.subject, ["x@y.cz"]))).toBeNull();
  });

  test("[BNK-012] neznámý předmět od Fio je unknown", () => {
    expect(fioParser.classify(meta("Fio banka - new notice"))).toBe("unknown");
    expect(fioParser.classify(meta(`${EN.subject} 1`))).toBe("unknown");
    expect(fioParser.parse(fixture("en-income"), meta("Fio banka - new notice"))).toBeNull();
  });

  test("parserFor vybere banku podle odesílatele a nese druh", () => {
    expect(parserFor(EN)).toEqual({ parser: fioParser, kind: "income" });
    expect(parserFor(meta("Fio banka - výdaj"))).toEqual({ parser: fioParser, kind: "expense" });
    expect(parserFor(meta(EN.subject, ["x@y.cz"]))).toBeNull();
    expect(BANK_PARSERS).toEqual([fioParser]);
    expect(fioParser).toMatchObject({ bank: "fio", domain: "fio.cz" });
  });

  test("[BNK-016] nový parser se přidá bez změny ostatních", () => {
    const other: BankNoticeParser = {
      bank: "jina",
      domain: "jina.cz",
      variants: ["jina_txt"],
      autoMatchVariants: ["jina_txt"],
      classify: ({ from }) => (from[0] === "avizo@jina.cz" ? "income" : null),
      parse: () => null,
    };
    expect(other.domain).toBe("jina.cz");
    const parsers = [fioParser, other];
    expect(parserFor(meta("x", ["avizo@jina.cz"]), parsers)).toEqual({
      parser: other,
      kind: "income",
    });
    expect(parserFor(EN, parsers)).toEqual({ parser: fioParser, kind: "income" });
    expect(parserFor(meta("x", ["x@y.cz"]), parsers)).toBeNull();
  });

  test("[BNK-016] id varianty je unikátní napříč bankami", () => {
    const named = (variants: string[], autoMatchVariants: string[] = []): BankNoticeParser => ({
      bank: "jina",
      domain: "jina.cz",
      variants,
      autoMatchVariants,
      classify: () => null,
      parse: () => null,
    });
    expect(() => assertVariantIds(BANK_PARSERS)).not.toThrow();
    // An "en" from another bank would inherit Fio's permission to pay invoices alone.
    expect(() => assertVariantIds([fioParser, named(["en"])])).toThrow("en");
    expect(() => assertVariantIds([named(["a", "a"])])).toThrow("a");
    expect(() => assertVariantIds([named(["a"], ["b"])])).toThrow("b");
    expect(fioParser.variants).toEqual(["en", "cs"]);
  });
});

describe("přísnost", () => {
  test("[BNK-012] změněný formát dá null, nikdy částečná data", () => {
    expect(fioParser.parse(fixture("en-changed-format"), EN)).toBeNull();
    for (const label of ["Account", "Amount", "Currency", "Date", "Instruction ID"]) {
      expect(fioParser.parse(enBody({ [label]: null }), EN)).toBeNull();
      expect(fioParser.parse(enBody({ [label]: "" }), EN)).toBeNull();
    }
    expect(fioParser.parse("", EN)).toBeNull();
  });

  test("1,234 v anglické variantě ani 1.234,50 v české není částka", () => {
    for (const amount of [
      "1,234",
      "1,234.50",
      "1.234",
      "1.5",
      "1 23.00",
      "12 34",
      "-1.00",
      "1.00 CZK",
      "0",
      "0.00",
      "0 001.00",
      "007.00",
      "00.50",
      "99999999999999999.00",
      "9".repeat(400),
    ]) {
      expect(fioParser.parse(enBody({ Amount: amount }), EN)).toBeNull();
    }
    for (const amount of ["1.234,50", "1.234", "1,234", "1,5", "12 34,00", "-1,00", "0,00"]) {
      expect(fioParser.parse(csBody({}, { amount }), CS)).toBeNull();
    }
  });

  test.each([
    ["1 234.50", 123_450],
    ["1 234 567.89", 123_456_789],
    ["1 234.00", 123_400],
    ["0.01", 1],
    ["1234", 123_400],
    ["1000000.00", 100_000_000],
  ])("anglická částka %s", (amount, minor) => {
    expect(fioParser.parse(enBody({ Amount: amount }), EN)?.amountMinor).toBe(minor);
  });

  test("největší bezpečná částka projde, o haléř vyšší ne", () => {
    const body = (amount: string) => enBody({ Amount: amount });
    expect(fioParser.parse(body("90071992547409.91"), EN)?.amountMinor).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(fioParser.parse(body("90071992547409.92"), EN)).toBeNull();
  });

  test.each(["HUF", "czk", "Kč", "C"])("měna %s mimo CURRENCIES je nerozpoznaná", (currency) => {
    expect(fioParser.parse(enBody({ Currency: currency }), EN)).toBeNull();
  });

  test.each([
    "2/30/2026",
    "13/1/2026",
    "0/1/2026",
    "10.30.2026",
    "30.10.2026",
    "10/30/26",
    "x10/30/2026",
    "10/30/2026x",
    "10/30/1999",
    "10/30/2100",
    "10/30/0026",
    "10/30/2026 24:00",
    "10/30/2026 14:60",
    "10/30/2026 4:05",
    "10/30/2026 14:05:00",
  ])("anglické datum %s je nerozpoznané", (date) => {
    expect(fioParser.parse(enBody({ Date: date }), EN)).toBeNull();
  });

  test("datum se čte podle jazyka bez záměny dne a měsíce", () => {
    expect(fioParser.parse(enBody({ Date: "3/4/2026 00:00" }), EN)?.occurredAt).toEqual({
      date: "2026-03-04",
      time: "00:00",
    });
    expect(
      fioParser.parse(csBody({}, { date: "3.4.2026", time: "23:59" }), CS)?.occurredAt,
    ).toEqual({ date: "2026-04-03", time: "23:59" });
  });

  test.each([
    ["Variable symbol", "12A"],
    ["Variable symbol", "12345678901"],
    ["Variable symbol", "1 2"],
    ["Constant symbol", "x"],
    ["Constant symbol", "12345678901"],
    ["Counterparty account", "abc"],
    ["Counterparty account", "1234567/12"],
    ["Counterparty account", "1234567-1/0800"],
    ["Counterparty account", "12345678901/0800"],
    ["Counterparty account", "x1/0800"],
    ["Counterparty account", "1/0800x"],
    ["Account", "abc"],
    ["Instruction ID", "12 34"],
    ["Instruction ID", "x".repeat(41)],
    ["Instruction ID", "a-b"],
  ])("pochybný údaj %s=%s shodí celé avízo", (label, value) => {
    expect(fioParser.parse(enBody({ [label]: value }), EN)).toBeNull();
  });

  test("nejdelší přípustné hodnoty projdou", () => {
    const parsed = fioParser.parse(
      enBody({
        Account: "123456-1234567890/0800",
        "Variable symbol": "1234567890",
        "Constant symbol": "1234567890",
        "Instruction ID": "a".repeat(40),
      }),
      EN,
    );
    expect(parsed).toMatchObject({
      targetAccount: "123456-1234567890/0800",
      variableSymbol: "1234567890",
      constantSymbol: "1234567890",
    });
  });

  test("opakovaný popisek je nejistota, ne první nebo poslední výskyt", () => {
    expect(fioParser.parse(`${enBody()}\nAmount: 999.00`, EN)).toBeNull();
    expect(fioParser.parse(`${enBody()}\nVariable symbol: 1\nVariable symbol: 2`, EN)).toBeNull();
  });

  test("víceřádková zpráva plátce nepřepíše ani nedoplní pole", () => {
    expect(
      fioParser.parse(`${enBody({ Message: "dik" })}\nVariable symbol: 666`, EN),
    ).toMatchObject({
      message: "dik",
      variableSymbol: null,
    });
    const real = enBody({ Message: "dik" });
    expect(fioParser.parse(`${real}\nAmount: 99000.00`, EN)?.amountMinor).toBe(10_000);
  });

  test("povinné pole za řádkem zprávy je nerozpoznané", () => {
    for (const [label, value] of [
      ["Account", "1"],
      ["Amount", "99000.00"],
      ["Currency", "CZK"],
      ["Date", "1/2/2026"],
      ["Instruction ID", "1"],
    ] as const) {
      const body = enBody({ [label]: null, Message: "dik" });
      expect(fioParser.parse(`${body}\n${label}: ${value}`, EN)).toBeNull();
    }
  });

  test("Credited amount a Amount ve zprávě nedá částku plátce", () => {
    const body = [
      "Account: 9999999999/2010",
      "Credited amount: 1.00",
      "Currency: CZK",
      "Date: 10/30/2026 14:05",
      "Instruction ID: 1",
      "Message: dik",
      "Amount: 99000.00",
    ].join("\n");
    expect(fioParser.parse(body, EN)).toBeNull();
  });

  test("HTML entita, NFD a BOM se nedomýšlejí", () => {
    expect(fioParser.parse(enBody({ Amount: "1&nbsp;234.50" }), EN)).toBeNull();
    expect(fioParser.classify(meta(CS.subject.normalize("NFD")))).toBe("unknown");
    expect(fioParser.parse(csBody(), meta(CS.subject.normalize("NFD")))).toBeNull();
    expect(fioParser.parse(csBody().normalize("NFD"), CS)).toBeNull();
    expect(fioParser.parse(`\uFEFF${enBody()}`, EN)?.targetAccount).toBe("9999999999/2010");
  });

  test("zpráva plátce nemůže podvrhnout jiné pole", () => {
    const parsed = fioParser.parse(enBody({ Message: "Amount: 999.00, Variable symbol: 666" }), EN);
    expect(parsed).toMatchObject({ amountMinor: 10_000, variableSymbol: null });
  });

  test("popisek se porovnává přesně a řádek bez dvojtečky se přeskočí", () => {
    expect(fioParser.parse(`${enBody({ Amount: null })}\nThe Amount: 1.00`, EN)).toBeNull();
    expect(fioParser.parse(`${enBody({ Amount: null })}\nAmount 1.00`, EN)).toBeNull();
    expect(fioParser.parse(`${enBody({ Amount: null })}\namount: 1.00`, EN)).toBeNull();
    expect(fioParser.parse(`${enBody()}\nAmountx`, EN)).not.toBeNull();
    expect(fioParser.parse(`${enBody({ Amount: null })}\nAmount : 1.00`, EN)).toBeNull();
    expect(fioParser.parse(enBody().replaceAll(/^/gm, "  "), EN)).not.toBeNull();
  });

  test("anglické popisky pod českým předmětem neplatí a naopak", () => {
    expect(fioParser.parse(enBody(), CS)).toBeNull();
    expect(fioParser.parse(csBody(), EN)).toBeNull();
  });

  test("vstup nad 64 KiB se nečte", () => {
    const body = enBody();
    const padded = (size: number) => `${body}\n${"x".repeat(size - body.length - 1)}`;
    expect(fioParser.parse(padded(64 * 1024), EN)).not.toBeNull();
    expect(fioParser.parse(padded(64 * 1024 + 1), EN)).toBeNull();
  });

  test("nebezpečný vstup doběhne rychle", () => {
    const size = 64 * 1024 - 1;
    const inputs = [
      "1 ".repeat(size / 2),
      "9".repeat(size),
      "Amount: " + "1 234".repeat(size / 6),
      "zůstatek účtu ".repeat(size / 15),
      `zůstatek účtu 1 se 1.1.2026 v 1:00 zvýšil o ${"1 ".repeat(size / 3)}`,
      "Protistrana: 1/0800 (" + "(".repeat(size / 2),
      " ".repeat(size),
      "\n".repeat(size),
    ];
    const start = performance.now();
    for (const input of inputs) {
      fioParser.parse(input, EN);
      fioParser.parse(input, CS);
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("soukromí", () => {
  test("parser nic nevypisuje ani u zamítnutého avíza", () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method));
    fioParser.parse(fixture("en-income"), EN);
    fioParser.parse(fixture("en-changed-format"), EN);
    fioParser.parse(fixture("cs-income"), CS);
    fioParser.parse(fixture("cs-changed-format"), CS);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  test("moduly avíz nesahají na logování ani Sentry", () => {
    const dir = join(import.meta.dirname, "../../src/lib/bank-notices");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source).not.toMatch(/console\.|sentry|logger|captureException/i);
    }
  });
});
