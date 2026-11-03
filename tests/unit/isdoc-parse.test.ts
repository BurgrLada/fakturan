import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isValidIco } from "@/lib/ico";
import { IsdocInvalid, parseIsdoc } from "@/server/isdoc/parse";

const DIR = join("tests", "fixtures", "isdoc");
const SCHEMA = join("src", "server", "isdoc", "schema");
const FICTIONAL_ICOS = ["99900017", "99900025", "99900033", "99900041", "99900050"];

const fixture = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const encoder = new TextEncoder();

function edited(name: string, from: string | RegExp, to: string): Uint8Array {
  return encoder.encode(new TextDecoder().decode(fixture(name)).replace(from, to));
}

describe("čtení ISDOC", () => {
  test("[IMP-003] faktura převezme číslo, UUID, typ, data, strany, položky, VS a účet", () => {
    const doc = parseIsdoc(fixture("faktura-czk.isdoc"));
    expect(doc).toMatchObject({
      type: "invoice",
      sourceType: "1",
      isdocVersion: "6.0.2",
      number: "2026-0001",
      uuid: "00000000-0000-4000-8000-000000000001",
      issueDate: "2026-02-02",
      taxableDate: "2026-02-02",
      dueDate: "2026-02-16",
      currency: "CZK",
      exchangeRateMicros: null,
      subtotalMinor: 335_050,
      roundingMinor: 0,
      totalMinor: 335_050,
      payableMinor: 335_050,
      paidDepositsMinor: 0,
      variableSymbol: "20260001",
      account: {
        number: "123456789",
        bankCode: "0100",
        iban: "CZ0001000000000123456789",
        swift: "ZKUSCZPP",
      },
      vatApplicable: false,
      note: "Smyšlený doklad pro testy",
      issuingSystem: "Zkušební systém 1.0",
    });
    expect(doc.supplier).toEqual({
      name: "Zkušební s. r. o.",
      street: "Zkušební 1",
      city: "Testov",
      zip: "123 45",
      country: "Česká republika",
      ico: "99900017",
      dic: "",
      email: "fakturace@zkusebni.example",
      phone: "",
    });
    expect(doc.customer).toMatchObject({
      name: "Vzorová a. s.",
      ico: "99900025",
      dic: "CZ99900025",
    });
    expect(doc.lines).toEqual([
      {
        name: "Konzultace",
        description: "",
        quantityMilli: 2000,
        unit: "hod",
        unitPriceMinor: 150_000,
        netMinor: 300_000,
      },
      {
        name: "Cestovné",
        description: "",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: 35_050,
        netMinor: 35_050,
      },
    ]);
  });

  test("[IMP-003] dobropis z kladných částek je v modelu záporný", () => {
    const doc = parseIsdoc(fixture("dobropis.isdoc"));
    expect(doc.type).toBe("credit_note");
    expect(doc.totalMinor).toBe(-150_000);
    expect(doc.payableMinor).toBe(-150_000);
    expect(doc.lines.map((l) => [l.unitPriceMinor, l.netMinor])).toEqual([[-150_000, -150_000]]);
    expect(doc.originalDocuments).toEqual([
      {
        number: "2026-0001",
        uuid: "00000000-0000-4000-8000-000000000001",
        issueDate: "2026-02-02",
      },
    ]);
  });

  test("[IMP-003] EUR bere částky *Curr a kurz z CurrRate/RefCurrRate", () => {
    const doc = parseIsdoc(fixture("faktura-eur.isdoc"));
    expect(doc.currency).toBe("EUR");
    expect(doc.exchangeRateMicros).toBe(25_125_000);
    expect(doc.totalMinor).toBe(40_999);
    expect(doc.lines.map((l) => l.netMinor)).toEqual([36_000, 4_999]);
    expect(doc.customer).toMatchObject({ country: "Německo", ico: "", dic: "DE999999999" });

    const perHundred = edited(
      "faktura-eur.isdoc",
      "<RefCurrRate>1</RefCurrRate>",
      "<RefCurrRate>100</RefCurrRate>",
    );
    expect(parseIsdoc(perHundred).exchangeRateMicros).toBe(251_250);
    const one = edited(
      "faktura-eur.isdoc",
      "<CurrRate>25.125</CurrRate>",
      "<CurrRate>1</CurrRate>",
    );
    expect(parseIsdoc(one).exchangeRateMicros).toBeNull();
  });

  test("[IMP-003] záloha, konečná faktura, úhrady, 6.0.1 a vrubopis", () => {
    expect(parseIsdoc(fixture("zalohova.isdoc")).type).toBe("advance");
    const final = parseIsdoc(fixture("konecna-se-zalohou.isdoc"));
    expect(final).toMatchObject({
      totalMinor: 2_500_000,
      paidDepositsMinor: 1_000_000,
      payableMinor: 1_500_000,
    });
    expect(final.deposits).toEqual([
      { number: "2026-Z001", variableSymbol: "2026Z001", amountMinor: 1_000_000 },
    ]);
    expect(parseIsdoc(fixture("uhrazena.isdoc")).payableMinor).toBe(0);
    expect(parseIsdoc(fixture("castecne-uhrazena.isdoc")).payableMinor).toBe(100_000);
    const old = parseIsdoc(fixture("verze-601.isdoc"));
    expect(old).toMatchObject({ isdocVersion: "6.0.1", totalMinor: 100_000, roundingMinor: 0 });
    expect(old.lines[0]).toMatchObject({
      quantityMilli: 12_500,
      unitPriceMinor: 8000,
      netMinor: 100_000,
    });
    expect(parseIsdoc(fixture("vrubopis.isdoc"))).toMatchObject({ type: null, sourceType: "3" });
    expect(parseIsdoc(fixture("cizi-dodavatel.isdoc")).supplier.ico).toBe("99900050");
  });

  test("zaokrouhlení dokladu jde do celku a rozdílu proti řádkům", () => {
    const rounded = edited(
      "verze-601.isdoc",
      "<PayableRoundingAmount>0.00</PayableRoundingAmount>",
      "<PayableRoundingAmount>0.40</PayableRoundingAmount>",
    );
    expect(parseIsdoc(rounded)).toMatchObject({
      subtotalMinor: 100_000,
      roundingMinor: 40,
      totalMinor: 100_040,
    });
  });

  test("[IMP-000] zdroj se nepředpokládá a IssuingSystem se zkrátí na 200 znaků", () => {
    const long = edited(
      "faktura-czk.isdoc",
      /<IssuingSystem>[^<]*/,
      `<IssuingSystem>${"x".repeat(300)}`,
    );
    expect(parseIsdoc(long).issuingSystem).toHaveLength(200);
    const none = edited("faktura-czk.isdoc", /<IssuingSystem>[^<]*<\/IssuingSystem>/, "");
    expect(parseIsdoc(none).issuingSystem).toBeNull();
  });

  test("nepodporovaná verze, chybějící element a neplatné číslo jsou chyba", () => {
    expect(() =>
      parseIsdoc(edited("faktura-czk.isdoc", 'version="6.0.2"', 'version="5.3"')),
    ).toThrow(IsdocInvalid);
    expect(() => parseIsdoc(edited("faktura-czk.isdoc", /<ID>2026-0001<\/ID>/, ""))).toThrow(
      "Chybí element ID",
    );
    expect(() =>
      parseIsdoc(
        edited(
          "faktura-czk.isdoc",
          "</TaxExclusiveAmount><TaxInclusiveAmount>3350.50",
          "</TaxExclusiveAmount><TaxInclusiveAmount>3.35e3",
        ),
      ),
    ).toThrow("Neplatné číslo v elementu TaxInclusiveAmount");
    expect(() =>
      parseIsdoc(
        edited(
          "faktura-czk.isdoc",
          "<IssueDate>2026-02-02</IssueDate><TaxPoint",
          "<IssueDate>2026-02-30</IssueDate><TaxPoint",
        ),
      ),
    ).toThrow("Neplatné datum");
    expect(() => parseIsdoc(encoder.encode("<Jine/>"))).toThrow("Soubor není faktura ISDOC");
  });

  test("[IMP-013] žádná fixtura neobsahuje IČO mimo seznam smyšlených", () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith(".isdoc"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const name of files) {
      const text = readFileSync(join(DIR, name), "utf8");
      const icos = [...text.matchAll(/<PartyIdentification>\s*<ID>([^<]*)<\/ID>/g)].map(
        (m) => m[1]!,
      );
      expect(icos.length, name).toBeGreaterThan(0);
      for (const ico of icos.filter(Boolean)) {
        expect(FICTIONAL_ICOS, `${name}: ${ico}`).toContain(ico);
        expect(isValidIco(ico)).toBe(true);
      }
      for (const [, dic] of text.matchAll(/<CompanyID>CZ(\d+)<\/CompanyID>/g)) {
        expect(FICTIONAL_ICOS, `${name}: DIČ CZ${dic}`).toContain(dic);
      }
    }
  });

  test("SHA-256 přiložených XSD odpovídá a LICENSE obsahuje odstavec svolení", () => {
    const sha = (name: string) =>
      createHash("sha256")
        .update(readFileSync(join(SCHEMA, name)))
        .digest("hex");
    expect(sha("isdoc-invoice-6.0.2.xsd")).toBe(
      "fb5de36fe7b5517acb8aa0c7950d91f8e28910e63b8cdcaaf7db0b0f4f0420bb",
    );
    expect(sha("isdoc-invoice-6.0.1.xsd")).toBe(
      "3ea488b0d544f1acf293df981b58138ac6e885fb3a7d5abf07c9b3b936b1b841",
    );
    const license = readFileSync(join(SCHEMA, "LICENSE.txt"), "utf8").replace(/\s+/g, " ");
    expect(license).toContain(
      "Permission to use, copy, modify and distribute this schema and its documentation for any purpose and without fee is hereby granted in perpetuity, provided that the above copyright notice and this paragraph appear in all copies.",
    );
    expect(license).toContain(
      "Neither the name of the SPIS, ICT UNIE, nor the name ISDOC may be used",
    );
    expect(license).toContain("(c) 2022 MVČR");
  });
});
