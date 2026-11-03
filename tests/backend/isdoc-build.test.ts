import { describe, expect, test } from "vitest";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { XML_LIMITS } from "@/lib/safe-input/limits";
import { parseXml } from "@/lib/safe-input/xml";
import { buildIsdoc, IsdocBuildError } from "@/server/isdoc/build";
import { parseIsdoc } from "@/server/isdoc/parse";
import { isdocRules } from "@/server/isdoc/rules";
import { validateIsdoc } from "@/server/isdoc/validate";
import { fixtureLine, INVOICE_FIXTURES as F } from "../fixtures/invoices";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const encoder = new TextEncoder();

async function exported(doc: InvoiceDocument, uuid = UUID) {
  const xml = buildIsdoc(doc, { uuid });
  const bytes = encoder.encode(xml);
  const [validation] = await validateIsdoc([{ name: "export", xml: bytes }]);
  expect(validation!.errors).toEqual([]);
  expect(isdocRules(parseXml(bytes, XML_LIMITS))).toEqual([]);
  return { xml, parsed: parseIsdoc(bytes) };
}

const creditNote: InvoiceDocument = {
  ...F.short,
  id: "fixture-credit",
  type: "credit_note",
  number: "2026-D01",
  lines: [fixtureLine({ unitPriceMinor: -150_000, netMinor: -300_000 })],
  totals: { ...F.short.totals, subtotalMinor: -300_000, totalMinor: -300_000 },
  relatedDocument: { type: "invoice", number: "2026-001", issueDate: "2026-03-01" },
};

describe("export ISDOC", () => {
  test("[TST-015] zpětně přečtený export má stejné částky, typ, UUID a položky", async () => {
    const { xml, parsed } = await exported(F.short);
    expect(xml).toContain('version="6.0.2"');
    expect(xml).toContain("<IssuingSystem>Fakturan</IssuingSystem>");
    expect(xml).toContain(
      "<ElectronicPossibilityAgreementReference></ElectronicPossibilityAgreementReference>",
    );
    expect(parsed).toMatchObject({
      type: "invoice",
      uuid: UUID,
      number: "2026-001",
      issueDate: "2026-03-10",
      taxableDate: "2026-03-09",
      dueDate: "2026-03-24",
      currency: "CZK",
      totalMinor: 300_000,
      payableMinor: 300_000,
      variableSymbol: "2026001",
      vatApplicable: false,
      issuingSystem: "Fakturan",
    });
    expect(parsed.lines).toEqual([
      {
        name: "Konzultace",
        description: "Návrh řešení a příprava podkladů",
        quantityMilli: 2000,
        unit: "hod.",
        unitPriceMinor: 150_000,
        netMinor: 300_000,
      },
    ]);
    expect(parsed.supplier).toMatchObject({
      name: "Jan Novák",
      ico: "27082440",
      country: "Česká republika",
    });
    expect(parsed.customer).toMatchObject({ ico: "12345678", dic: "CZ12345678" });
    expect(parsed.account).toEqual({
      number: "19-2000145399",
      bankCode: "0800",
      iban: "CZ6508000000192000145399",
      swift: "GIBACZPX",
    });
    expect(parsed.note).toContain("Poznámka k dokladu");
  });

  test("[TST-015] sleva dokladu je záporný řádek a součet sedí", async () => {
    const discounted: InvoiceDocument = {
      ...F.short,
      discountKind: "amount",
      discountValue: 50_000,
      rounding: "whole",
      lines: [
        fixtureLine({ netMinor: 300_000 }),
        fixtureLine({
          name: "Drobnost",
          quantityMilli: 1000,
          unitPriceMinor: 12_345,
          netMinor: 12_345,
        }),
      ],
      totals: {
        ...F.short.totals,
        subtotalMinor: 312_345,
        discountMinor: 50_000,
        roundingMinor: -45,
        totalMinor: 262_300,
      },
    };
    const { xml, parsed } = await exported(discounted);
    expect(parsed.lines.at(-1)).toEqual({
      name: "Sleva",
      description: "",
      quantityMilli: 1000,
      unit: "",
      unitPriceMinor: -50_000,
      netMinor: -50_000,
    });
    expect(parsed.subtotalMinor).toBe(262_345);
    expect(parsed.roundingMinor).toBe(-45);
    expect(parsed.totalMinor).toBe(262_300);
    expect(xml).toContain("<PayableRoundingAmount>-0.45</PayableRoundingAmount>");
  });

  test("[TST-015] dobropis je v ISDOC kladný a nese odkaz, záloha má typ 4", async () => {
    const credit = buildIsdoc(creditNote, {
      uuid: UUID,
      relatedUuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    });
    expect(credit).toContain("<DocumentType>2</DocumentType>");
    expect(credit).toContain("<TaxInclusiveAmount>3000.00</TaxInclusiveAmount>");
    const { parsed } = await exported(creditNote);
    expect(parsed).toMatchObject({
      type: "credit_note",
      totalMinor: -300_000,
      payableMinor: -300_000,
    });
    expect(parsed.originalDocuments).toEqual([
      { number: "2026-001", uuid: null, issueDate: "2026-03-01" },
    ]);
    expect(parseIsdoc(encoder.encode(credit)).originalDocuments[0]!.uuid).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
    );

    const advance = await exported({ ...F.short, type: "advance" });
    expect(advance.xml).toContain("<DocumentType>4</DocumentType>");
    expect(advance.parsed.type).toBe("advance");
  });

  test("[TST-015] EUR doplní všechny *Curr a domácí částky přepočte kurzem dokladu", async () => {
    const eur: InvoiceDocument = { ...F.eur, exchangeRateMicros: 25_125_000 };
    const { xml, parsed } = await exported(eur);
    expect(xml).toContain("<ForeignCurrencyCode>EUR</ForeignCurrencyCode>");
    expect(xml).toContain("<CurrRate>25.125000</CurrRate>");
    expect(parsed.currency).toBe("EUR");
    expect(parsed.exchangeRateMicros).toBe(25_125_000);
    expect(parsed.totalMinor).toBe(eur.totals.totalMinor);
    expect(parsed.lines.map((l) => l.netMinor)).toEqual(eur.lines.map((l) => l.netMinor));
  });

  test("[TST-015] zálohy a platby jdou do PaidDepositsAmount a k úhradě je zůstatek", async () => {
    const paid: InvoiceDocument = {
      ...F.short,
      totals: { ...F.short.totals, advanceMinor: 100_000, paidMinor: 50_000 },
    };
    const { xml, parsed } = await exported(paid);
    expect(xml).toContain("<PaidDepositsAmount>1500.00</PaidDepositsAmount>");
    expect(parsed.payableMinor).toBe(150_000);
    const over = await exported({ ...F.short, totals: { ...F.short.totals, paidMinor: 400_000 } });
    expect(over.parsed.payableMinor).toBe(0);
    const deposits = buildIsdoc(paid, {
      uuid: UUID,
      deposits: [{ number: "2026-Z01", variableSymbol: "2026901", amountMinor: 100_000 }],
    });
    expect(parseIsdoc(encoder.encode(deposits)).deposits).toEqual([
      { number: "2026-Z01", variableSymbol: "2026901", amountMinor: 100_000 },
    ]);
  });

  test("[EXP-005] zahraniční strana dostane kód země a platné znaky zůstanou", async () => {
    const foreign: InvoiceDocument = {
      ...F.short,
      note: "ﬁnance \uE000 \u{1F600} \uFFFD",
      snapshot: {
        ...F.short.snapshot,
        customer: {
          ...F.short.snapshot.customer!,
          country: "Německo",
          dic: "DE999999999",
          ico: "",
        },
      },
    };
    const { xml, parsed } = await exported(foreign);
    expect(xml).toMatch(/<IdentificationCode>DE<\/IdentificationCode><Name>Německo<\/Name>/);
    expect(parsed.note).toContain("ﬁnance \uE000 \u{1F600} \uFFFD");
    const byName = buildIsdoc(
      {
        ...foreign,
        snapshot: {
          ...foreign.snapshot,
          customer: { ...foreign.snapshot.customer!, dic: "", country: "Slovensko" },
        },
      },
      { uuid: UUID },
    );
    expect(byName).toContain("<IdentificationCode>SK</IdentificationCode>");
  });

  test("koncept a cizí měna bez kurzu se neexportují", () => {
    expect(() => buildIsdoc({ ...F.short, status: "draft" }, { uuid: UUID })).toThrow(
      IsdocBuildError,
    );
    expect(() => buildIsdoc({ ...F.eur, exchangeRateMicros: null }, { uuid: UUID })).toThrow(
      "nemá kurz",
    );
  });

  test("texty se escapují a řídicí znaky zmizí", async () => {
    const tricky: InvoiceDocument = {
      ...F.short,
      note: 'A & B <x> "q"\u0001',
      lines: [fixtureLine({ name: "Řádek <b>&" })],
    };
    const { parsed } = await exported(tricky);
    expect(parsed.note).toContain('A & B <x> "q"');
    expect(parsed.note).not.toContain("\u0001");
    expect(parsed.lines[0]!.name).toBe("Řádek <b>&");
  });
});
