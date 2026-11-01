import { describe, expect, test } from "vitest";
import { REVERSE_CHARGE_CLAUSE } from "@/lib/clauses";
import {
  applyCustomerDefaults,
  applyRate,
  changeCurrency,
  changeForeign,
  changeLanguage,
  changeRate,
  customerForeign,
  customerOffer,
  foreignFieldsOpen,
  foreignOffer,
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
  formQrState,
  formRateNotes,
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
  { id: "czk", currency: "CZK", isDefault: true, iban: true, czechIban: true, bic: true },
  { id: "eur-1", currency: "EUR", isDefault: false, iban: true, czechIban: true, bic: true },
  { id: "eur-2", currency: "EUR", isDefault: true, iban: true, czechIban: true, bic: true },
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
    foreign: false,
    dic: "",
    vatIdentified: false,
    clauseTexts: REVERSE_CHARGE_CLAUSE,
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
      foreign: false,
      dic: "",
      vatIdentified: false,
      clauseTexts: REVERSE_CHARGE_CLAUSE,
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

const clauses = {
  vatIdentified: true,
  customerDic: "DE123456789",
  texts: REVERSE_CHARGE_CLAUSE,
};
const none = new Set<never>();
const customer = {
  dueDays: 14,
  language: "cs",
  currency: "EUR",
  paymentMethod: "transfer",
  appearance: document.appearance,
  foreign: true,
  dic: "DE123456789",
  vatIdentified: true,
  clauseTexts: REVERSE_CHARGE_CLAUSE,
} as const;

describe("zahraniční faktura", () => {
  test("[FOR-001] zapnutí navrhne doložku, vypnutí vrátí měnu a smaže kurz i doložku", () => {
    const on = changeForeign(form(), true, { ...clauses, currency: "CZK" }, none, accounts);
    expect(on).toMatchObject({ foreign: true, clause: REVERSE_CHARGE_CLAUSE.cs, currency: "CZK" });
    const off = changeForeign(
      { ...on, currency: "EUR", exchangeRate: "25", exchangeRateSource: "manual" },
      false,
      { ...clauses, currency: "CZK" },
      none,
      accounts,
    );
    expect(off).toMatchObject({
      foreign: false,
      clause: "",
      currency: "CZK",
      exchangeRate: "",
      exchangeRateSource: null,
      bankAccountId: "czk",
    });
  });

  test("[FOR-001] zamčená měna přepínač nevypne a vypnutí ji nezmění", () => {
    const values = form({ foreign: true, currency: "EUR", exchangeRate: "25" });
    const off = changeForeign(
      values,
      false,
      { ...clauses, currency: "CZK", currencyLocked: true },
      none,
      accounts,
    );
    expect(off).toMatchObject({ foreign: false, currency: "EUR", exchangeRate: "25" });
  });

  test("[FOR-001] zákazník přenese přepínač a doložku, ručně upravené nechá", () => {
    expect(applyCustomerDefaults(form(), customer, none, accounts)).toMatchObject({
      foreign: true,
      clause: REVERSE_CHARGE_CLAUSE.cs,
      currency: "EUR",
    });
    const kept = applyCustomerDefaults(
      form({ clause: "Moje" }),
      customer,
      new Set(["clause", "foreign"] as const),
      accounts,
    );
    expect(kept).toMatchObject({ foreign: false, clause: "Moje" });
  });

  const domestic = { ...customer, foreign: false, dic: "" };

  test("[FOR-006] domácí zákazník smaže navrženou doložku, vlastní jen po potvrzení", () => {
    const suggested = form({ foreign: true, clause: REVERSE_CHARGE_CLAUSE.cs });
    expect(customerForeign(suggested, domestic, none)).toMatchObject({
      foreign: false,
      clause: "",
    });

    const own = form({ foreign: true, clause: "Moje znění" });
    expect(customerForeign(own, domestic, none)).toMatchObject({
      foreign: false,
      clause: "Moje znění",
    });
    expect(foreignOffer(own, domestic, none)).toEqual({ foreign: false, clause: "" });
    expect(foreignOffer(customerForeign(own, domestic, none), domestic, none)).toEqual({
      clause: "",
    });
    expect(foreignOffer(form(), domestic, none)).toBeNull();
  });

  test("[FOR-006] doložka na domácím dokladu nezůstane skrytá a odkaz na ni vede", () => {
    expect(foreignFieldsOpen(form())).toBe(false);
    expect(foreignFieldsOpen(form({ clause: "Moje" }))).toBe(true);
    expect(foreignFieldsOpen(form({ clause: "  " }))).toBe(false);
    expect(foreignFieldsOpen(form({ foreign: true }))).toBe(true);
    expect(foreignFieldsOpen(form({ currency: "EUR" }))).toBe(true);
    expect(fieldTarget("clause", form(), 1)).toEqual({ href: "#field-clause", external: false });
  });

  test("[FOR-001] nabídka u uloženého dokladu přenese přepínač, doložku i smazání kurzu", () => {
    const values = form({ currency: "USD", exchangeRate: "22", exchangeRateSource: "manual" });
    expect(customerOffer(values, customer, none, accounts)).toMatchObject({
      foreign: true,
      clause: REVERSE_CHARGE_CLAUSE.cs,
      currency: "EUR",
      exchangeRate: "",
      exchangeRateSource: null,
    });
  });

  test("[FOR-003] změna EUR na USD smaže i ruční kurz a načte nový", () => {
    const values = form({ currency: "EUR", exchangeRate: "25", exchangeRateSource: "manual" });
    expect(changeCurrency(values, "USD", none, accounts)).toMatchObject({
      currency: "USD",
      exchangeRate: "",
      exchangeRateSource: null,
    });
    expect(changeCurrency(values, "EUR", none, accounts).exchangeRate).toBe("25");
  });

  test("[FOR-003] změna data přenačte automatický kurz, ruční zůstane", () => {
    const result = {
      rateMicros: 24_380_000,
      source: "cnb",
      listDate: "2026-10-30",
      reference: 24_380_000,
    } as const;
    const automatic = form({ currency: "EUR", exchangeRate: "24", exchangeRateSource: "cnb" });
    expect(applyRate(automatic, result)).toMatchObject({
      exchangeRate: "24,38",
      exchangeRateSource: "cnb",
    });
    const typed = form({ currency: "EUR", exchangeRate: "25", exchangeRateSource: "manual" });
    expect(applyRate(typed, result)).toBe(typed);
    expect(applyRate(typed, null)).toBe(typed);
    expect(applyRate(automatic, null)).toBe(automatic);
  });

  test("[FOR-003] psaní do pole nastaví ruční kurz, smazání vrátí automatiku", () => {
    expect(changeRate(form(), "25,5")).toMatchObject({
      exchangeRate: "25,5",
      exchangeRateSource: "manual",
    });
    expect(changeRate(form(), " ").exchangeRateSource).toBeNull();
  });

  test("[FOR-003] rozepsaný kurz starší uložený bez zdroje se bere jako ruční", () => {
    const saved = formFromDocument(
      {
        ...document,
        currency: "EUR",
        exchangeRateMicros: 25_000_000,
        customerId: null,
        seriesId: null,
        lines: [],
      },
      "ks",
    );
    expect(saved.exchangeRateSource).toBe("manual");
  });

  test("[FOR-001] zdroj kurzu u CZK a prázdného kurzu do dokumentu nejde", () => {
    const fields = (over: Partial<FormValues>) => {
      const result = toDocumentFields(form(over), "invoice");
      return result.ok ? result.fields : null;
    };
    expect(fields({ exchangeRateSource: "cnb" })?.exchangeRateSource).toBeNull();
    expect(
      fields({ currency: "EUR", exchangeRate: "", exchangeRateSource: "cnb" })?.exchangeRateSource,
    ).toBeNull();
  });

  test("[FOR-007] změna jazyka přeloží neupravenou doložku, upravenou nechá", () => {
    const shown = form({ foreign: true, clause: REVERSE_CHARGE_CLAUSE.cs });
    expect(changeLanguage(shown, "en", clauses, none)).toMatchObject({
      language: "en",
      clause: REVERSE_CHARGE_CLAUSE.en,
    });
    const edited = { ...shown, clause: "Vlastní znění" };
    expect(changeLanguage(edited, "en", clauses, none).clause).toBe("Vlastní znění");
    expect(changeLanguage(shown, "en", clauses, new Set(["clause"] as const)).clause).toBe(
      REVERSE_CHARGE_CLAUSE.cs,
    );
    const removed = { ...shown, clause: "" };
    expect(changeLanguage(removed, "en", clauses, none).clause).toBe("");
  });

  test("[QR-002] změna účtu důvod změní", () => {
    const list = [
      { id: "bare", currency: "EUR", isDefault: true, iban: false, czechIban: false, bic: false },
      { id: "no-bic", currency: "EUR", isDefault: false, iban: true, czechIban: true, bic: false },
      { id: "full", currency: "EUR", isDefault: false, iban: true, czechIban: true, bic: true },
    ];
    const state = (bankAccountId: string | null, currency: FormValues["currency"] = "EUR") =>
      formQrState(form({ currency, bankAccountId }), list);
    expect(state("bare")).toBe("missing_iban_bic");
    expect(state("no-bic")).toBe("missing_iban_bic");
    expect(state("full")).toBe("epc");
    expect(state(null)).toBe("no_account");
    expect(state("full", "USD")).toBe("currency");
    expect(state("no-bic", "CZK")).toBe("spayd");
    expect(state("bare", "CZK")).toBe("missing_iban_bic");
    const abroad = [
      { id: "de", currency: "CZK", isDefault: true, iban: true, czechIban: false, bic: true },
    ];
    expect(formQrState(form({ bankAccountId: "de" }), abroad)).toBe("not_czech_account");
    expect(formQrState(form({ bankAccountId: "de", currency: "EUR" }), abroad)).toBe("epc");
  });

  test("[QR-002] vypnuté QR a jiná platba mají vlastní důvod", () => {
    const values = form({ bankAccountId: "czk" });
    const hidden = { ...values, appearance: { ...values.appearance, showQr: false } };
    expect(formQrState(hidden, accounts)).toBe("turned_off");
    expect(formQrState({ ...values, paymentMethod: "cash" }, accounts)).toBe("other_payment");
  });

  test("[FOR-004] [FOR-010] upozornění u kurzu ve formuláři", () => {
    const base = { currency: "EUR", dateFormat: "d. M. yyyy" } as const;
    expect(
      formRateNotes({
        ...base,
        rateMicros: 24_000_000,
        source: "last_known",
        listDate: "2026-10-29",
        reference: 24_000_000,
      }),
    ).toEqual([expect.stringContaining("29. 10. 2026")]);
    expect(
      formRateNotes({
        ...base,
        rateMicros: 26_250_000,
        source: "fixed",
        listDate: null,
        reference: 25_000_000,
      }),
    ).toEqual([]);
    expect(
      formRateNotes({
        ...base,
        rateMicros: 26_250_001,
        source: "manual",
        listDate: null,
        reference: 25_000_000,
      }),
    ).toEqual([expect.stringContaining("5 %")]);
    expect(
      formRateNotes({
        ...base,
        rateMicros: 26_000_000,
        source: "manual",
        listDate: null,
        reference: null,
      }),
    ).toEqual([expect.stringContaining("nešlo ověřit")]);
  });
});
