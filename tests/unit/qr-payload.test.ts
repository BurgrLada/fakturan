import { describe, expect, test } from "vitest";
import { amountDue, planQr } from "@/lib/qr-payload";

const CZ_IBAN = "CZ6508000000192000145399";
const DE_IBAN = "DE89370400440532013000";

const czk = {
  currency: "CZK",
  dueMinor: 123450,
  iban: CZ_IBAN,
  bic: null,
  variableSymbol: "2026001",
  message: "Faktura 2026001",
  recipient: "Acme s.r.o.",
  enabled: true,
  paid: false,
};

const eur = {
  ...czk,
  currency: "EUR",
  iban: DE_IBAN,
  bic: "COBADEFFXXX",
  recipient: "Acme GmbH",
};

describe("planQr SPAYD", () => {
  test("[QR-001] CZK na český účet dá přesně očekávaný řetězec SPAYD", () => {
    expect(planQr(czk)).toEqual({
      kind: "spayd",
      payload:
        "SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*X-VS:2026001*MSG:Faktura 2026001",
    });
  });

  test("[QR-001] částka má vždy dvě desetinná místa", () => {
    const amount = (dueMinor: number) =>
      (planQr({ ...czk, dueMinor }) as { payload: string }).payload.match(/\*AM:([^*]+)\*/)?.[1];
    expect(amount(5)).toBe("0.05");
    expect(amount(100)).toBe("1.00");
    expect(amount(1000)).toBe("10.00");
    expect(amount(99999999)).toBe("999999.99");
  });

  test("[QR-001] diakritika a hvězdička ve zprávě", () => {
    const plan = planQr({ ...czk, message: "Příliš žluťoučký kůň * 5 %" });
    expect(plan).toEqual({
      kind: "spayd",
      payload:
        "SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*X-VS:2026001*MSG:Prilis zlutoucky kun %2A 5 %25",
    });
  });

  test("[QR-001] prázdné atributy se vynechají", () => {
    const base = "SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK";
    expect(planQr({ ...czk, variableSymbol: "", message: "" })).toEqual({
      kind: "spayd",
      payload: base,
    });
    expect(planQr({ ...czk, variableSymbol: null, message: null })).toEqual({
      kind: "spayd",
      payload: base,
    });
    expect(planQr({ ...czk, message: "  " })).toEqual({
      kind: "spayd",
      payload: `${base}*X-VS:2026001`,
    });
    expect(planQr({ ...czk, variableSymbol: "" })).toEqual({
      kind: "spayd",
      payload: `${base}*MSG:Faktura 2026001`,
    });
  });

  test("[QR-001] zpráva má nejvýš 60 znaků a ořez nerozdělí celý znak", () => {
    const long = (message: string) =>
      (planQr({ ...czk, message }) as { payload: string }).payload.split("*MSG:")[1];
    expect(long("a".repeat(70))).toBe("a".repeat(60));
    expect(long("a".repeat(60))).toBe("a".repeat(60));
    expect(long("a".repeat(59) + "😀😀")).toBe("a".repeat(59) + "😀");
    expect(long("ř".repeat(61))).toBe("r".repeat(60));
    expect(long("*".repeat(70))).toBe("%2A".repeat(60));
  });

  test("[QR-001] IBAN se normalizuje a variabilní symbol má jen číslice", () => {
    const plan = planQr({
      ...czk,
      iban: "cz65 0800 0000 1920 0014 5399",
      variableSymbol: "VS-2026/001",
    });
    expect(plan).toEqual({
      kind: "spayd",
      payload:
        "SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*X-VS:2026001*MSG:Faktura 2026001",
    });
  });

  test("[QR-001] variabilní symbol má nejvýš deset číslic", () => {
    const plan = planQr({ ...czk, variableSymbol: "123456789012" }) as { payload: string };
    expect(plan.payload).toContain("*X-VS:1234567890*");
  });

  test("[QR-001] CZK na cizí účet nedá QR", () => {
    expect(planQr({ ...czk, iban: DE_IBAN })).toEqual({
      kind: "none",
      reason: "not_czech_account",
    });
  });

  test("[QR-001] CZK bez IBAN nedá QR", () => {
    expect(planQr({ ...czk, iban: null })).toEqual({ kind: "none", reason: "missing_iban_bic" });
    expect(planQr({ ...czk, iban: " " })).toEqual({ kind: "none", reason: "missing_iban_bic" });
  });
});

describe("planQr EPC", () => {
  test("[QR-002] EUR s IBAN a BIC dá EPC", () => {
    expect(planQr(eur)).toEqual({
      kind: "epc",
      payload: [
        "BCD",
        "002",
        "1",
        "SCT",
        "COBADEFFXXX",
        "Acme GmbH",
        "DE89370400440532013000",
        "EUR1234.50",
        "",
        "",
        "VS2026001 Faktura 2026001",
      ].join("\n"),
    });
  });

  test("[QR-002] EPC bez zprávy má jen VS a bez VS jen zprávu", () => {
    const lines = (input: typeof eur) =>
      (planQr(input) as { payload: string }).payload.split("\n")[10];
    expect(lines({ ...eur, message: "" })).toBe("VS2026001");
    expect(lines({ ...eur, variableSymbol: "" })).toBe("Faktura 2026001");
    expect(lines({ ...eur, variableSymbol: "", message: "" })).toBe("");
  });

  test("[QR-002] EPC zpráva je bez diakritiky a má nejvýš 140 znaků, příjemce 70", () => {
    const plan = planQr({
      ...eur,
      recipient: "Ř".repeat(80),
      message: "ž".repeat(200),
    }) as { payload: string };
    const lines = plan.payload.split("\n");
    expect(lines[5]).toBe("Ř".repeat(70));
    expect(lines[10]).toBe(`VS2026001 ${"z".repeat(130)}`);
    expect(lines[10]).toHaveLength(140);
  });

  test("[QR-002] ořez EPC zprávy zachová celý znak", () => {
    const plan = planQr({
      ...eur,
      variableSymbol: "",
      message: "a".repeat(139) + "😀😀",
    }) as { payload: string };
    expect(plan.payload.split("\n")[10]).toBe("a".repeat(139) + "😀");
    const name = planQr({ ...eur, recipient: "a".repeat(69) + "😀😀" }) as { payload: string };
    expect(name.payload.split("\n")[5]).toBe("a".repeat(69) + "😀");
  });

  test("[QR-002] EPC normalizuje IBAN i BIC", () => {
    const plan = planQr({ ...eur, iban: "de89 3704 0044 0532 0130 00", bic: " cobadeffxxx " }) as {
      payload: string;
    };
    const lines = plan.payload.split("\n");
    expect(lines[4]).toBe("COBADEFFXXX");
    expect(lines[6]).toBe("DE89370400440532013000");
  });

  test("[QR-002] EUR bez BIC nedá QR s důvodem", () => {
    expect(planQr({ ...eur, bic: null })).toEqual({ kind: "none", reason: "missing_iban_bic" });
    expect(planQr({ ...eur, bic: "  " })).toEqual({ kind: "none", reason: "missing_iban_bic" });
  });

  test("[QR-002] EUR bez IBAN nedá QR s důvodem", () => {
    expect(planQr({ ...eur, iban: null })).toEqual({ kind: "none", reason: "missing_iban_bic" });
  });

  test("[QR-002] EUR na český účet s BIC dá EPC", () => {
    const plan = planQr({ ...eur, iban: CZ_IBAN, bic: "GIBACZPX" });
    expect(plan.kind).toBe("epc");
  });
});

describe("planQr důvody", () => {
  test("[QR-003] USD nedá QR", () => {
    expect(planQr({ ...czk, currency: "USD" })).toEqual({ kind: "none", reason: "currency" });
    expect(planQr({ ...eur, currency: "PLN" })).toEqual({ kind: "none", reason: "currency" });
  });

  test("[QR-005] vypnutá faktura nedá QR", () => {
    expect(planQr({ ...czk, enabled: false })).toEqual({ kind: "none", reason: "disabled" });
  });

  test("[QR-005] uhrazená faktura nedá QR", () => {
    expect(planQr({ ...czk, paid: true })).toEqual({ kind: "none", reason: "paid" });
  });

  test("[QR-005] pořadí důvodů: vypnuto, uhrazeno, nulová částka, měna", () => {
    const all = { ...czk, currency: "USD", dueMinor: 0 };
    expect(planQr({ ...all, enabled: false, paid: true })).toEqual({
      kind: "none",
      reason: "disabled",
    });
    expect(planQr({ ...all, paid: true })).toEqual({ kind: "none", reason: "paid" });
    expect(planQr(all)).toEqual({ kind: "none", reason: "zero" });
    expect(planQr({ ...all, dueMinor: 1 })).toEqual({ kind: "none", reason: "currency" });
  });

  test("[QR-006] nulová nebo záporná částka nedá QR", () => {
    expect(planQr({ ...czk, dueMinor: 0 })).toEqual({ kind: "none", reason: "zero" });
    expect(planQr({ ...czk, dueMinor: -1 })).toEqual({ kind: "none", reason: "zero" });
    expect(planQr({ ...czk, dueMinor: 1 }).kind).toBe("spayd");
  });
});

describe("amountDue", () => {
  test("[QR-006] částka je zbývající, ne celková", () => {
    expect(amountDue({ totalMinor: 100000, paidMinor: 0 })).toBe(100000);
    expect(amountDue({ totalMinor: 100000, paidMinor: 40050 })).toBe(59950);
    expect(amountDue({ totalMinor: 100000, paidMinor: 100000 })).toBe(0);
  });

  test("[QR-006] QR nese zbývající částku po částečné úhradě", () => {
    const dueMinor = amountDue({ totalMinor: 123450, paidMinor: 23450 });
    const plan = planQr({ ...czk, dueMinor }) as { payload: string };
    expect(plan.payload).toContain("*AM:1000.00*");
    const epc = planQr({ ...eur, dueMinor }) as { payload: string };
    expect(epc.payload.split("\n")[7]).toBe("EUR1000.00");
  });
});
