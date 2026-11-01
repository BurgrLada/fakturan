import { describe, expect, test } from "vitest";
import {
  applyCustomerDefaults,
  customerOffer,
  discountNotes,
  changeTaxableDate,
  draftFields,
  blankLine,
  changeIssueDate,
  computeFormTotals,
  defaultAccountId,
  fieldTarget,
  formatRate,
  formFromDocument,
  isEmptyLine,
  parseRate,
  hasFixedDiscount,
  toDocumentFields,
  type FormValues,
} from "@/lib/invoice-form";

const document = {
  bankAccountId: "czk",
  issueDate: "2026-03-10",
  dueDate: "2026-03-24",
  taxableDate: null,
  language: "cs",
  currency: "CZK",
  exchangeRateMicros: null,
  paymentMethod: "transfer",
  orderRef: "",
  reference: "",
  textBefore: "",
  textAfter: "",
  note: "",
  discountKind: "none",
  discountValue: 0,
  rounding: "none",
  appearance: {
    designId: "cisty",
    colors: { accent: "", surface: "", text: "", line: "" },
    logoPosition: "left",
    showLogo: true,
    showQr: true,
    showQrLogo: false,
    showSignature: false,
    showDuzp: false,
  },
} as const;

const form = (over: Partial<FormValues> = {}): FormValues => ({
  ...formFromDocument({ ...document, customerId: null, seriesId: null, lines: [] }, "ks"),
  ...over,
});

const accounts = [
  { id: "czk", currency: "CZK", isDefault: true },
  { id: "eur-1", currency: "EUR", isDefault: false },
  { id: "eur-2", currency: "EUR", isDefault: true },
] as const;

describe("formulář faktury", () => {
  test("[INV-012] prázdný řádek je jen ten bez obsahu, jednotka a množství se nepočítají", () => {
    expect(isEmptyLine(blankLine("hod."))).toBe(true);
    expect(isEmptyLine({ ...blankLine("ks"), name: "A" })).toBe(false);
    expect(isEmptyLine({ ...blankLine("ks"), description: "A" })).toBe(false);
    expect(isEmptyLine({ ...blankLine("ks"), price: "10" })).toBe(false);
    expect(isEmptyLine({ ...blankLine("ks"), catalogItemId: "c" })).toBe(false);
  });

  test("[INV-012] prázdný řádek se do dokladu neposílá", () => {
    const lines = [blankLine("ks"), { ...blankLine("ks"), name: "Práce", price: "1 234,50" }];

    const result = toDocumentFields(form({ lines }), "invoice");

    expect(result).toMatchObject({
      ok: true,
      fields: { lines: [{ name: "Práce", quantityMilli: 1000, unitPriceMinor: 123_450 }] },
    });
  });

  test("[INV-012] neplatná částka vrátí pole k opravě", () => {
    const line = { ...blankLine("ks"), name: "Práce", price: "abc" };
    expect(toDocumentFields(form({ lines: [line] }), "invoice")).toEqual({
      ok: false,
      invalid: [`line-${line.key}-price`],
    });
    const quantity = { ...blankLine("ks"), name: "Práce", quantity: "1,2345" };
    expect(toDocumentFields(form({ lines: [quantity] }), "invoice")).toEqual({
      ok: false,
      invalid: [`line-${quantity.key}-quantity`],
    });
  });

  test("[INV-012] záporná cena neprojde", () => {
    const line = { ...blankLine("ks"), name: "Práce", price: "-5" };
    expect(toDocumentFields(form({ lines: [line] }), "invoice")).toMatchObject({ ok: false });
  });

  test("pevnou slevu pozná na dokladu i na položce, procentní ne", () => {
    const line = { ...blankLine("ks"), discountKind: "amount" as const };
    expect(hasFixedDiscount(form({ discountKind: "amount" }))).toBe(true);
    expect(hasFixedDiscount(form({ lines: [line] }))).toBe(true);
    expect(hasFixedDiscount(form({ discountKind: "percent" }))).toBe(false);
  });

  test("formulář přijme -100 jen u opravné faktury", () => {
    const line = { ...blankLine("ks"), name: "Vratka", price: "-100" };
    const values = form({ lines: [line] });
    expect(toDocumentFields(values, "credit_note")).toMatchObject({
      ok: true,
      fields: { lines: [{ unitPriceMinor: -10000 }] },
    });
    expect(computeFormTotals(values, "credit_note")?.totalMinor).toBe(-10000);

    for (const type of ["invoice", "advance"] as const) {
      expect(toDocumentFields(values, type)).toEqual({
        ok: false,
        invalid: [`line-${line.key}-price`],
      });
      expect(computeFormTotals(values, type)).toBeNull();
    }
  });

  test("záporná sleva neprojde ani u opravné faktury", () => {
    const line = {
      ...blankLine("ks"),
      name: "Vratka",
      price: "-100",
      discountKind: "amount" as const,
      discount: "-5",
    };
    expect(toDocumentFields(form({ lines: [line] }), "credit_note")).toEqual({
      ok: false,
      invalid: [`line-${line.key}-discount`],
    });
    expect(
      toDocumentFields(form({ discountKind: "amount", discount: "-5" }), "credit_note"),
    ).toEqual({ ok: false, invalid: ["field-discount"] });
  });

  test("záporná cena se do formuláře načte a uloží beze změny", () => {
    const saved = {
      catalogItemId: null,
      name: "Vratka",
      description: "",
      quantityMilli: 1000,
      unit: "ks",
      unitPriceMinor: -125050,
      discountKind: "none" as const,
      discountValue: 0,
    };
    const values = formFromDocument(
      { ...document, customerId: null, seriesId: null, lines: [saved] },
      "ks",
    );
    expect(values.lines[0]?.price).toBe("-1250,50");
    expect(toDocumentFields(values, "credit_note")).toMatchObject({
      ok: true,
      fields: { lines: [{ unitPriceMinor: -125050 }] },
    });
  });

  test("[INV-014] sleva v procentech jsou setiny procenta, částkou haléře", () => {
    const line = {
      ...blankLine("ks"),
      name: "A",
      discountKind: "percent",
      discount: "12,5",
    } as const;
    const result = toDocumentFields(
      form({ lines: [line], discountKind: "amount", discount: "100" }),
      "invoice",
    );
    expect(result).toMatchObject({
      ok: true,
      fields: {
        discountKind: "amount",
        discountValue: 10_000,
        lines: [{ discountKind: "percent", discountValue: 1250 }],
      },
    });
  });

  test("[INV-012] součty ve formuláři dává stejná funkce jako na serveru", () => {
    const line = { ...blankLine("ks"), name: "A", quantity: "1,5", price: "1234,56" };

    expect(computeFormTotals(form({ lines: [line] }), "invoice")).toMatchObject({
      totalMinor: 185_184,
    });
    expect(computeFormTotals(form({ lines: [{ ...line, price: "x" }] }), "invoice")).toBeNull();
  });

  test("[INV-012] formulář z uloženého dokladu vrátí stejné pole", () => {
    const saved = {
      ...document,
      customerId: "c",
      seriesId: "s",
      exchangeRateMicros: 24_500_000,
      currency: "EUR",
      discountKind: "percent",
      discountValue: 1250,
      lines: [
        {
          catalogItemId: null,
          name: "A",
          description: "",
          quantityMilli: 1500,
          unit: "hod.",
          unitPriceMinor: 12_345,
          discountKind: "amount",
          discountValue: 500,
        },
      ],
    } as const;

    const result = toDocumentFields(formFromDocument(saved, "ks"), "invoice");

    expect(result).toMatchObject({
      ok: true,
      fields: {
        exchangeRateMicros: 24_500_000,
        discountValue: 1250,
        lines: [saved.lines[0]],
      },
    });
  });

  test("[FOR-002] kurz se počítá v milióntinách a u CZK se neposílá", () => {
    expect(parseRate("24,5")).toBe(24_500_000);
    expect(parseRate("24.123456")).toBe(24_123_456);
    expect(parseRate("24,1234567")).toBeNull();
    expect(parseRate("0")).toBeNull();
    expect(parseRate("x")).toBeNull();
    expect(formatRate(24_500_000)).toBe("24,5");
    expect(formatRate(null)).toBe("");

    expect(
      toDocumentFields(form({ currency: "CZK", exchangeRate: "24" }), "invoice"),
    ).toMatchObject({
      fields: { exchangeRateMicros: null },
    });
    expect(
      toDocumentFields(form({ currency: "EUR", exchangeRate: "24" }), "invoice"),
    ).toMatchObject({
      fields: { exchangeRateMicros: 24_000_000 },
    });
    expect(toDocumentFields(form({ currency: "EUR", exchangeRate: "" }), "invoice")).toMatchObject({
      fields: { exchangeRateMicros: null },
    });
  });

  test("[INV-019] vyplněné DUZP zapne jeho zobrazení v PDF", () => {
    const filled = changeTaxableDate(form(), "2026-03-01");
    expect(toDocumentFields(filled, "invoice")).toMatchObject({
      fields: { taxableDate: "2026-03-01", appearance: { showDuzp: true } },
    });

    const off = { ...filled.appearance, showDuzp: false };
    const edited = changeTaxableDate({ ...filled, appearance: off }, "2026-03-02");
    expect(edited.appearance.showDuzp).toBe(false);
  });

  test("[FOR-002] účet se volí podle měny, výchozí má přednost", () => {
    expect(defaultAccountId(accounts, "EUR")).toBe("eur-2");
    expect(defaultAccountId(accounts, "USD")).toBeNull();
  });

  const defaults = {
    dueDays: 30,
    language: "en",
    currency: "EUR",
    paymentMethod: "cash",
    appearance: { ...document.appearance, designId: "mono" },
  } as const;

  test("[INV-010] změna zákazníka přepíše výchozí pole", () => {
    const next = applyCustomerDefaults(form(), defaults, new Set(), accounts);

    expect(next).toMatchObject({
      dueDate: "2026-04-09",
      language: "en",
      currency: "EUR",
      bankAccountId: "eur-2",
      paymentMethod: "cash",
      appearance: { designId: "mono" },
    });
  });

  test("[INV-010] uložený dokument dostane jen nabídku rozdílných hodnot", () => {
    expect(customerOffer(form(), defaults, new Set(), accounts)).toEqual({
      currency: "EUR",
      bankAccountId: "eur-2",
      language: "en",
      paymentMethod: "cash",
      appearance: defaults.appearance,
      dueDate: "2026-04-09",
    });
  });

  test("[INV-023] doklad s platbou nedostane nabídku měny ani účtu", () => {
    expect(customerOffer(form(), defaults, new Set(), accounts, true)).toEqual({
      language: "en",
      paymentMethod: "cash",
      appearance: defaults.appearance,
      dueDate: "2026-04-09",
    });
  });

  test("[INV-010] nabídka vynechá shodné a uživatelem změněné hodnoty", () => {
    const same = {
      ...defaults,
      currency: "CZK",
      language: "cs",
      appearance: document.appearance,
    } as const;
    const offer = customerOffer(
      form({ bankAccountId: "jiny" }),
      same,
      new Set(["dueDate"]),
      accounts,
    );

    expect(offer).toEqual({ paymentMethod: "cash" });
  });

  test("[INV-010] bez rozdílu se nic nenabízí", () => {
    const same = {
      dueDays: 14,
      language: "cs",
      currency: "CZK",
      paymentMethod: "transfer",
      appearance: document.appearance,
    } as const;

    expect(customerOffer(form(), same, new Set(), accounts)).toBeNull();
  });

  test("[INV-014] omezená sleva dostane poznámku, běžná ne", () => {
    const line = {
      quantityMilli: 1000,
      unitPriceMinor: 10_000,
      discountKind: "amount",
      discountValue: 20_000,
    } as const;
    const totals = (subtotalMinor: number, grossMinor: number) => ({
      lines: [{ grossMinor, discountMinor: 0, netMinor: 0 }],
      subtotalMinor,
      discountMinor: 0,
      roundingMinor: 0,
      totalMinor: 0,
    });

    expect(
      discountNotes({ discountKind: "amount", discountValue: 1, lines: [line] }, totals(0, 10_000)),
    ).toHaveLength(2);
    expect(
      discountNotes(
        { discountKind: "percent", discountValue: 10_000, lines: [line] },
        totals(30_000, 30_000),
      ),
    ).toEqual([]);
  });

  test("[INV-010] změna zákazníka nesáhne na pole změněná uživatelem", () => {
    const touched = new Set(["language", "dueDate", "currency", "appearance"] as const);

    const next = applyCustomerDefaults(form(), defaults, touched, accounts);

    expect(next).toMatchObject({
      dueDate: "2026-03-24",
      language: "cs",
      currency: "CZK",
      bankAccountId: "czk",
      paymentMethod: "cash",
      appearance: { designId: "cisty" },
    });
  });

  test("[INV-010] ručně vybraný účet změna zákazníka nepřepíše", () => {
    const next = applyCustomerDefaults(
      form({ bankAccountId: "eur-1" }),
      defaults,
      new Set(["bankAccountId"] as const),
      accounts,
    );
    expect(next.bankAccountId).toBe("eur-1");
  });

  test("[INV-019] splatnost drží odstup od data vystavení, dokud ji uživatel nezměnil", () => {
    expect(changeIssueDate(form(), "2026-04-01", new Set())).toMatchObject({
      issueDate: "2026-04-01",
      dueDate: "2026-04-15",
    });
    expect(changeIssueDate(form(), "2026-04-01", new Set(["dueDate"] as const))).toMatchObject({
      issueDate: "2026-04-01",
      dueDate: "2026-03-24",
    });
  });

  test("[INV-010] zákazník nevypne zobrazení vyplněného DUZP", () => {
    const filled = changeTaxableDate(form(), "2026-03-01");
    const next = applyCustomerDefaults(filled, defaults, new Set(), accounts);
    expect(next.appearance).toMatchObject({ designId: "mono", showDuzp: true });
  });

  test("[SEC-006] formulář nese jen své pole a typ dokladu se nepřepisuje", () => {
    const values = formFromDocument(
      {
        ...document,
        customerId: null,
        seriesId: null,
        lines: [],
        status: "paid",
        number: "1",
      } as Parameters<typeof formFromDocument>[0],
      "ks",
    );
    expect(values).not.toHaveProperty("status");
    expect(values).not.toHaveProperty("number");

    const result = toDocumentFields(values, "invoice");
    if (!result.ok) throw new Error("neplatné");
    expect(draftFields("advance", values, result.fields)).toMatchObject({ type: "advance" });
    expect(result.fields).not.toHaveProperty("status");
  });

  test("[SET-031] neplatná barva je pole k opravě, prázdná platí", () => {
    const colors = { ...document.appearance.colors };
    expect(toDocumentFields(form(), "invoice")).toMatchObject({ ok: true });

    const appearance = { ...document.appearance, colors: { ...colors, accent: "modrá" } };
    expect(toDocumentFields(form({ appearance }), "invoice")).toEqual({
      ok: false,
      invalid: ["field-color-accent"],
    });
  });

  test("[INV-010] problém ukazuje na pole ve formuláři nebo do nastavení", () => {
    const empty = blankLine("ks");
    const kept = { ...blankLine("ks"), name: "A" };
    const values = form({ lines: [empty, kept] });

    expect(fieldTarget("supplier.ico", values, 1)).toEqual({
      href: "/nastaveni/dodavatel",
      external: true,
    });
    expect(fieldTarget("supplier.notVatPayerCs", values, 1).href).toBe("/nastaveni/dodavatel");
    expect(fieldTarget("seriesId", values, 1).href).toBe("/nastaveni/rady");
    expect(fieldTarget("bankAccountId", values, 0).href).toBe("/nastaveni/ucty");
    expect(fieldTarget("bankAccountId", values, 1).href).toBe("#field-bankAccountId");
    expect(fieldTarget("customerId", values, 1).href).toBe("#field-customerId");
    expect(fieldTarget("lines.0.name", values, 1).href).toBe(`#line-${kept.key}-name`);
    expect(fieldTarget("lines.0.quantityMilli", values, 1).href).toBe(`#line-${kept.key}-quantity`);
    expect(fieldTarget("lines", values, 1).href).toBe("#field-lines");
  });
});
