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
const PROVISIONAL = "# PROZATÍMNÍ: nesestaveno z reálného vzorku";

const fixture = (name: string) =>
  readFileSync(join(FIXTURES, `${name}.txt`), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");

const meta = (subject: string, from = ["automat@fio.cz"]): NoticeMeta => ({ from, subject });
const EN = meta("Fio banka - new income on account");
const CS_BLOCK = meta("Fio banka - příjem na kontě");
const CS_SENTENCE = meta("Fio banka - příjem na účtu");

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

const csBody = (overrides: Record<string, string | null> = {}) =>
  Object.entries({
    "Příjem na kontě": "9999999999/2010",
    Částka: "100,00",
    Měna: "CZK",
    Datum: "30.10.2026 14:05",
    "ID pokynu": "10000000001",
    ...overrides,
  })
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");

const sentenceBody = (sentence: string) =>
  [sentence, "Datum: 30.10.2026 14:05", "ID pokynu: 10000000001"].join("\n");

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

// BNK-005 stays partial: no real Czech notice exists, so these prove the parser
// against assumed labels only and AUTO_MATCH_VARIANTS keeps them out of matching.
describe("prozatímní česká varianta", () => {
  test("[BNK-005] prozatímní česká bloková varianta s desetinnou čárkou", () => {
    expect(fioParser.parse(fixture("cs-provisional-block"), CS_BLOCK)).toEqual({
      ...FULL,
      variant: "cs_block",
      counterpartyName: "Ukázková Firma s.r.o.",
      message: "Fiktivní platba",
      instructionId: "10000000003",
    });
  });

  test("[BNK-005] prozatímní česká větná varianta", () => {
    expect(fioParser.parse(fixture("cs-provisional-sentence"), CS_SENTENCE)).toEqual({
      ...FULL,
      variant: "cs_sentence",
      counterpartyName: "Ukázková Firma s.r.o.",
      message: "Fiktivní platba",
      instructionId: "10000000004",
    });
  });

  test("větná varianta smí začínat velkým písmenem bez tečky na konci", () => {
    const parsed = fioParser.parse(
      sentenceBody("Zůstatek účtu 9999999999 se zvýšil o 100,50 EUR"),
      CS_SENTENCE,
    );
    expect(parsed).toMatchObject({
      targetAccount: "9999999999",
      amountMinor: 10_050,
      currency: "EUR",
    });
  });

  test.each([
    [
      "druhá věta v textu",
      "zůstatek účtu 1 se zvýšil o 1,00 CZK\nzůstatek účtu 2 se zvýšil o 9,00 CZK",
    ],
    ["žádná věta", "Dobrý den"],
    ["slovo přilepené před větou", "xzůstatek účtu 1 se zvýšil o 1,00 CZK"],
    ["text za větou", "zůstatek účtu 1 se zvýšil o 1,00 CZK navíc"],
    ["neplatný účet", "zůstatek účtu abc se zvýšil o 1,00 CZK"],
    ["tečka v částce", "zůstatek účtu 1 se zvýšil o 1.00 CZK"],
    ["neznámá měna", "zůstatek účtu 1 se zvýšil o 1,00 HUF"],
  ])("větná varianta je nerozpoznaná: %s", (_, sentence) => {
    expect(fioParser.parse(sentenceBody(sentence), CS_SENTENCE)).toBeNull();
  });

  test("větná varianta přijme celou částku a konce řádků CRLF", () => {
    const body = sentenceBody("Zůstatek účtu 1 se zvýšil o 1 000 CZK.").replaceAll("\n", "\r\n");
    expect(fioParser.parse(body, CS_SENTENCE)?.amountMinor).toBe(100_000);
  });

  test("předmět určí podobu, bloková zpráva pod předmětem větné nejde dál", () => {
    expect(fioParser.parse(fixture("cs-provisional-block"), CS_SENTENCE)).toBeNull();
    expect(fioParser.parse(fixture("cs-provisional-sentence"), CS_BLOCK)).toBeNull();
  });

  test("[BNK-005] česká varianta se automaticky nepáruje", () => {
    expect(AUTO_MATCH_VARIANTS).toEqual(["en"]);
    expect(isProvisional("en")).toBe(false);
    expect(isProvisional("cs_block")).toBe(true);
    expect(isProvisional("cs_sentence")).toBe(true);
  });
});

describe("fixtury", () => {
  const files = readdirSync(FIXTURES);

  test("každá fixtura je označená jako syntetická a česká jako prozatímní", () => {
    expect(files).toHaveLength(6);
    for (const file of files) {
      const lines = readFileSync(join(FIXTURES, file), "utf8").split("\n");
      expect(lines).toContain(SYNTHETIC);
      if (file.startsWith("cs-provisional-")) expect(lines[0]).toBe(PROVISIONAL);
    }
  });

  // TST-006 stays partial: the IMAP flow arrives in Task 5 and the Czech samples are provisional.
  test("[TST-006] všechny fixtury v obou jazycích", () => {
    const cases: [string, NoticeMeta, "income" | "expense" | "unknown", boolean][] = [
      ["en-income", EN, "income", true],
      ["en-income-minimal", EN, "income", true],
      ["cs-provisional-block", CS_BLOCK, "income", true],
      ["cs-provisional-sentence", CS_SENTENCE, "income", true],
      ["en-expense", meta("Fio banka - expense on account"), "expense", false],
      ["en-changed-format", EN, "income", false],
    ];
    expect(cases.map(([name]) => `${name}.txt`).sort()).toEqual([...files].sort());
    for (const [name, noticeMeta, kind, parses] of cases) {
      expect(fioParser.classify(noticeMeta)).toBe(kind);
      expect(fioParser.parse(fixture(name), noticeMeta) !== null).toBe(parses);
    }
  });
});

describe("třídění", () => {
  test("[BNK-004] jen přesný odesílatel a tři předměty jdou do parseru", () => {
    for (const subject of [EN.subject, CS_BLOCK.subject, CS_SENTENCE.subject]) {
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
    expect(fioParser.variants).toEqual(["en", "cs_block", "cs_sentence"]);
  });
});

describe("přísnost", () => {
  test("[BNK-012] změněný formát dá null, nikdy částečná data", () => {
    expect(fioParser.parse(fixture("en-changed-format"), EN)).toBeNull();
    for (const label of ["Account", "Amount", "Currency", "Date", "Instruction ID"]) {
      expect(fioParser.parse(enBody({ [label]: null }), EN)).toBeNull();
      expect(fioParser.parse(enBody({ [label]: "" }), EN)).toBeNull();
    }
    for (const label of ["Příjem na kontě", "Částka", "Měna", "Datum", "ID pokynu"]) {
      expect(fioParser.parse(csBody({ [label]: null }), CS_BLOCK)).toBeNull();
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
      expect(fioParser.parse(csBody({ Částka: amount }), CS_BLOCK)).toBeNull();
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

  test.each([
    ["1 234,50", 123_450],
    ["1 234,50", 123_450],
    ["0,01", 1],
    ["1 234", 123_400],
  ])("česká částka %s", (amount, minor) => {
    expect(fioParser.parse(csBody({ Částka: amount }), CS_BLOCK)?.amountMinor).toBe(minor);
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

  test.each(["30.2.2026", "1.13.2026", "10/30/2026", "x1.2.2026", "1.2.2026x", "1.2.2026 24:00"])(
    "české datum %s je nerozpoznané",
    (date) => {
      expect(fioParser.parse(csBody({ Datum: date }), CS_BLOCK)).toBeNull();
    },
  );

  test("datum se čte podle jazyka bez záměny dne a měsíce", () => {
    expect(fioParser.parse(enBody({ Date: "3/4/2026 00:00" }), EN)?.occurredAt).toEqual({
      date: "2026-03-04",
      time: "00:00",
    });
    expect(fioParser.parse(csBody({ Datum: "3.4.2026 23:59" }), CS_BLOCK)?.occurredAt).toEqual({
      date: "2026-04-03",
      time: "23:59",
    });
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
    expect(
      fioParser.parse(`${csBody({ "Zpráva příjemci": "x" })}\nČástka: 9,00`, CS_BLOCK),
    ).toMatchObject({ amountMinor: 10_000, message: "x" });
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

  test.each([
    "Zpráva příjemci: zůstatek účtu 1 se zvýšil o 99000,00 CZK",
    "Zpráva příjemci: x\nzůstatek účtu 1 se zvýšil o 99000,00 CZK",
    "Protistrana: zůstatek účtu 1 se zvýšil o 99000,00 CZK",
    "Vážený kliente: zůstatek účtu 1 se zvýšil o 99000,00 CZK",
    "Text. zůstatek účtu 1 se zvýšil o 99000,00 CZK",
  ])("věta podvržená ve zprávě se nečte: %s", (line) => {
    const body = ["Datum: 30.10.2026 14:05", "ID pokynu: 1", line].join("\n");
    expect(fioParser.parse(body, CS_SENTENCE)).toBeNull();
  });

  test("věta za zprávou plátce nepřebije skutečnou", () => {
    const body = [
      "Vážený kliente, zůstatek účtu 1 se zvýšil o 1,00 CZK.",
      "Datum: 30.10.2026 14:05",
      "ID pokynu: 1",
      "Zpráva příjemci: x",
      "zůstatek účtu 2 se zvýšil o 99000,00 EUR",
    ].join("\n");
    expect(fioParser.parse(body, CS_SENTENCE)).toMatchObject({
      targetAccount: "1",
      amountMinor: 100,
      currency: "CZK",
    });
  });

  test("HTML entita, NFD a BOM se nedomýšlejí", () => {
    expect(fioParser.parse(enBody({ Amount: "1&nbsp;234.50" }), EN)).toBeNull();
    expect(fioParser.classify(meta(CS_BLOCK.subject.normalize("NFD")))).toBe("unknown");
    expect(fioParser.parse(csBody(), meta(CS_BLOCK.subject.normalize("NFD")))).toBeNull();
    expect(fioParser.parse(csBody().normalize("NFD"), CS_BLOCK)).toBeNull();
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
    expect(fioParser.parse(enBody(), CS_BLOCK)).toBeNull();
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
      " ".repeat(size),
      "\n".repeat(size),
    ];
    const start = performance.now();
    for (const input of inputs) {
      fioParser.parse(input, EN);
      fioParser.parse(input, CS_SENTENCE);
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
