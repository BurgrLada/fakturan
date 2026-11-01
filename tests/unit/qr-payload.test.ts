import { describe, expect, test } from "vitest";
import { amountDue, planQr, qrStateOf } from "@/lib/qr-payload";

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
    expect(long("a".repeat(59) + "😀😀")).toBe("a".repeat(59));
    expect(long("a".repeat(59) + " b")).toBe("a".repeat(59));
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

  test("[QR-001] variabilní symbol delší než deset číslic se vynechá, ne zkrátí", () => {
    const plan = planQr({ ...czk, variableSymbol: "12345678901" }) as { payload: string };
    expect(plan.payload).not.toContain("X-VS");
    const ten = planQr({ ...czk, variableSymbol: "1234567890" }) as { payload: string };
    expect(ten.payload).toContain("*X-VS:1234567890*");
    const epc = planQr({ ...eur, variableSymbol: "12345678901" }) as { payload: string };
    expect(epc.payload.split("\n")[10]).toBe("Faktura 2026001");
  });

  test("[QR-001] text je tisknutelné ASCII: transliterace, řídicí znaky a řádky", () => {
    const msg = (message: string) =>
      (planQr({ ...czk, variableSymbol: "", message }) as { payload: string }).payload.split(
        "*MSG:",
      )[1];
    expect(msg("Łódź ß Øre Ærø Œuvre Đ")).toBe("Lodz ss Ore AEro OEuvre D");
    expect(msg("a\r\nb\tc\u0000d\u2028e")).toBe("a b c d e");
    expect(msg("  a    b  ")).toBe("a b");
    expect(msg("a😀b€c")).toBe("abc");
    expect(planQr({ ...czk, message: "😀" })).toEqual({
      kind: "spayd",
      payload: "SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*X-VS:2026001",
    });
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

  test("[QR-002] EPC text je ASCII, zpráva má nejvýš 140 znaků, příjemce 70", () => {
    const plan = planQr({
      ...eur,
      recipient: "Ř".repeat(80),
      message: "ž".repeat(200),
    }) as { payload: string };
    const lines = plan.payload.split("\n");
    expect(lines[5]).toBe("R".repeat(70));
    expect(lines[10]).toBe(`VS2026001 ${"z".repeat(130)}`);
    expect(lines[10]).toHaveLength(140);
  });

  test("[QR-002] emoji se z EPC odstraní, ořez nenechá koncovou mezeru", () => {
    const plan = planQr({
      ...eur,
      variableSymbol: "",
      message: "a".repeat(139) + "😀😀",
    }) as { payload: string };
    expect(plan.payload.split("\n")[10]).toBe("a".repeat(139));
    const name = planQr({ ...eur, recipient: "a".repeat(69) + " b" }) as { payload: string };
    expect(name.payload.split("\n")[5]).toBe("a".repeat(69));
  });

  test("[QR-002] nejhorší EPC se vejde do 331 bajtů", () => {
    const plan = planQr({
      ...eur,
      dueMinor: 99_999_999_999,
      recipient: "Ř😀".repeat(50),
      message: "Ž😀".repeat(100),
    }) as { payload: string };
    expect(plan.payload).toMatch(/^[\x20-\x7e\n]+$/);
    expect(Buffer.byteLength(plan.payload)).toBeLessThanOrEqual(331);
    expect(plan.payload.split("\n")).toHaveLength(11);
  });

  test("[QR-002] EPC přes 331 bajtů vyhodí chybu", () => {
    const fill = (length: number) => ({
      ...eur,
      dueMinor: 99_999_999_999,
      recipient: "R".repeat(70),
      message: "m".repeat(200),
      iban: "D".repeat(length),
    });
    const ok = planQr(fill(75)) as { payload: string };
    expect(Buffer.byteLength(ok.payload)).toBe(331);
    expect(() => planQr(fill(76))).toThrow("331");
  });

  test("[QR-002] transliterace pokrývá všechna speciální písmena", () => {
    const plan = planQr({
      ...eur,
      variableSymbol: "",
      message: "ŁłßØøÆæŒœĐđÐðÞþı",
    }) as { payload: string };
    expect(plan.payload.split("\n")[10]).toBe("LlssOoAEaeOEoeDdDdThthi");
  });

  test("[QR-002] příjemce s novým řádkem drží pole na svých řádcích", () => {
    const plan = planQr({ ...eur, recipient: "Acme\ns.r.o.", message: "a\nb" }) as {
      payload: string;
    };
    const lines = plan.payload.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[5]).toBe("Acme s.r.o.");
    expect(lines[10]).toBe("VS2026001 a b");
  });

  test("[QR-001] SPAYD s CRLF ve zprávě je zploštěný", () => {
    const plan = planQr({ ...czk, message: "a\r\nb" }) as { payload: string };
    expect(plan.payload).not.toMatch(/[\r\n]/);
    expect(plan.payload).toContain("*MSG:a b");
  });

  test("[QR-002] EPC s prázdným příjemcem po vyčištění nedá QR", () => {
    for (const recipient of ["", "  ", "😀", "\n"]) {
      expect(planQr({ ...eur, recipient })).toEqual({
        kind: "none",
        reason: "missing_recipient",
      });
    }
    expect(planQr({ ...czk, recipient: "" }).kind).toBe("spayd");
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

  test("[QR-006] nekonečná, desetinná a nebezpečná částka nedá QR", () => {
    for (const dueMinor of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(planQr({ ...czk, dueMinor })).toEqual({ kind: "none", reason: "zero" });
    }
  });

  test("[QR-006] částka nad 999999999.99 nedá QR, na hranici ano", () => {
    expect(planQr({ ...czk, dueMinor: 100_000_000_000 })).toEqual({
      kind: "none",
      reason: "amount_too_large",
    });
    expect(planQr({ ...eur, dueMinor: 100_000_000_000 })).toEqual({
      kind: "none",
      reason: "amount_too_large",
    });
    const edge = planQr({ ...czk, dueMinor: 99_999_999_999 }) as { payload: string };
    expect(edge.payload).toContain("*AM:999999999.99*");
    const epc = planQr({ ...eur, dueMinor: 99_999_999_999 }) as { payload: string };
    expect(epc.payload.split("\n")[7]).toBe("EUR999999999.99");
  });

  test("[QR-006] nulová nebo záporná částka nedá QR", () => {
    expect(planQr({ ...czk, dueMinor: 0 })).toEqual({ kind: "none", reason: "zero" });
    expect(planQr({ ...czk, dueMinor: -1 })).toEqual({ kind: "none", reason: "zero" });
    expect(planQr({ ...czk, dueMinor: 1 }).kind).toBe("spayd");
  });
});

const balance = {
  totalMinor: 100000,
  paidMinor: 0,
  creditsMinor: 0,
  advanceMinor: 0,
  supersededAt: null,
};

describe("amountDue", () => {
  test("[QR-006] částka je zbývající, ne celková", () => {
    expect(amountDue(balance)).toBe(100000);
    expect(amountDue({ ...balance, paidMinor: 40050 })).toBe(59950);
    expect(amountDue({ ...balance, paidMinor: 100000 })).toBe(0);
  });

  test("[CRN-005] 12 100,00 - oprava 2 100,00 - platba 4 000,00 dá 6 000,00", () => {
    expect(
      amountDue({ ...balance, totalMinor: 1_210_000, creditsMinor: -210_000, paidMinor: 400_000 }),
    ).toBe(600_000);
  });

  test("[CRN-006] záporný zůstatek je přeplatek", () => {
    expect(
      amountDue({ ...balance, totalMinor: 500_000, creditsMinor: -150_000, paidMinor: 500_000 }),
    ).toBe(-150_000);
  });

  test("uhrazená záloha snižuje zůstatek", () => {
    expect(amountDue({ ...balance, advanceMinor: 30000 })).toBe(70000);
  });

  test("nahrazená záloha nemá co vybírat, přeplatek zůstává", () => {
    const supersededAt = new Date("2026-03-01T10:00:00Z");
    expect(amountDue({ ...balance, supersededAt })).toBe(0);
    expect(amountDue({ ...balance, paidMinor: 100001, supersededAt })).toBe(-1);
  });

  test("[QR-006] QR nese zbývající částku po částečné úhradě", () => {
    const dueMinor = amountDue({ ...balance, totalMinor: 123450, paidMinor: 23450 });
    const plan = planQr({ ...czk, dueMinor }) as { payload: string };
    expect(plan.payload).toContain("*AM:1000.00*");
    const epc = planQr({ ...eur, dueMinor }) as { payload: string };
    expect(epc.payload.split("\n")[7]).toBe("EUR1000.00");
  });
});

describe("qrStateOf", () => {
  const account = { iban: "CZ6508000000192000145399", swift: "GIBACZPX" };
  const doc = (over: object = {}) =>
    ({
      status: "issued",
      currency: "CZK",
      paymentMethod: "transfer",
      variableSymbol: "2026001",
      totals: { ...balance, totalMinor: 100_000 },
      appearance: { showQr: true },
      snapshot: { account, supplier: { name: "Jan Novák" } },
      ...over,
    }) as unknown as Parameters<typeof qrStateOf>[0];

  test("[QR-002] každý důvod chybějícího QR má vlastní stav", () => {
    expect(qrStateOf(doc())).toBe("spayd");
    expect(qrStateOf(doc({ currency: "EUR" }))).toBe("epc");
    expect(qrStateOf(doc({ status: "cancelled" }))).toBe("settled");
    expect(qrStateOf(doc({ status: "credited" }))).toBe("settled");
    expect(qrStateOf(doc({ status: "paid" }))).toBe("paid");
    expect(qrStateOf(doc({ paymentMethod: "cash" }))).toBe("other_payment");
    expect(qrStateOf(doc({ appearance: { showQr: false } }))).toBe("turned_off");
    expect(qrStateOf(doc({ currency: "USD" }))).toBe("currency");
    expect(qrStateOf(doc({ totals: { ...balance, totalMinor: 0 } }))).toBe("zero");
    expect(
      qrStateOf(
        doc({
          currency: "EUR",
          snapshot: { account: { iban: account.iban, swift: "" }, supplier: { name: "J" } },
        }),
      ),
    ).toBe("missing_iban_bic");
    expect(qrStateOf(doc({ snapshot: { account: null, supplier: { name: "Jan Novák" } } }))).toBe(
      "no_account",
    );
  });
});
