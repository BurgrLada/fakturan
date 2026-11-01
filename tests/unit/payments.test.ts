import { describe, expect, test } from "vitest";
import {
  canAmendPayment,
  canTakePayment,
  deriveStatus,
  isRefund,
  PAYMENT_CHANNELS,
  PAYMENT_KINDS,
  PAYMENT_SOURCES,
  paymentInputSchema,
} from "@/lib/payments";
import { MAX_DOCUMENT_MINOR } from "@/lib/invoice-totals";
import { INVOICE_STATUSES } from "@/lib/invoice";

const SENT_AT = new Date("2026-03-01T10:00:00Z");

describe("deriveStatus", () => {
  const sent = {
    status: "sent" as const,
    sentAt: SENT_AT,
    totalMinor: 1000,
    paidMinor: 0,
    creditsMinor: 0,
    advanceMinor: 0,
  };

  test("[PAY-002] součet plateb určí částečnou a plnou úhradu", () => {
    expect(deriveStatus({ ...sent, paidMinor: 1 })).toBe("partially_paid");
    expect(deriveStatus({ ...sent, paidMinor: 999 })).toBe("partially_paid");
    expect(deriveStatus({ ...sent, paidMinor: 1000 })).toBe("paid");
  });

  test("[PAY-004] přeplatek zůstává uhrazený", () => {
    expect(deriveStatus({ ...sent, paidMinor: 1001 })).toBe("paid");
  });

  test("[PAY-005] bez plateb se základ řídí tím, jestli doklad odešel", () => {
    expect(deriveStatus({ ...sent, status: "paid" })).toBe("sent");
    expect(deriveStatus({ ...sent, status: "paid", sentAt: null })).toBe("issued");
    expect(deriveStatus({ ...sent, status: "partially_paid", sentAt: null })).toBe("issued");
  });

  test("nulový doklad se nikdy neuhradí, ani s platbou", () => {
    expect(deriveStatus({ ...sent, totalMinor: 0 })).toBe("sent");
    expect(deriveStatus({ ...sent, totalMinor: 0, paidMinor: 500 })).toBe("sent");
    expect(deriveStatus({ ...sent, totalMinor: 0, paidMinor: 500, sentAt: null })).toBe("issued");
  });

  test.each(["draft", "cancelled"] as const)("stav %s zůstává beze změny", (status) => {
    expect(deriveStatus({ ...sent, status, paidMinor: 1000 })).toBe(status);
  });

  test("[CRN-006] úplná oprava bez plateb je dobropisovaná", () => {
    expect(deriveStatus({ ...sent, creditsMinor: -1000 })).toBe("credited");
  });

  test("[CRN-006] s platbou nebo zálohou zůstává uhrazená s přeplatkem", () => {
    expect(deriveStatus({ ...sent, creditsMinor: -1000, paidMinor: 1 })).toBe("paid");
    expect(deriveStatus({ ...sent, creditsMinor: -1000, advanceMinor: 1 })).toBe("paid");
    expect(deriveStatus({ ...sent, creditsMinor: -400, paidMinor: 1000 })).toBe("paid");
  });

  test("[CRN-006] částečná oprava dobropis nezaloží", () => {
    expect(deriveStatus({ ...sent, creditsMinor: -400 })).toBe("sent");
    expect(deriveStatus({ ...sent, creditsMinor: -400, paidMinor: 100 })).toBe("partially_paid");
    expect(deriveStatus({ ...sent, creditsMinor: -400, paidMinor: 600 })).toBe("paid");
  });

  test("[CRN-006] nulový doklad bez oprav dobropisovaný není", () => {
    expect(deriveStatus({ ...sent, totalMinor: 0, creditsMinor: 0 })).toBe("sent");
  });

  test("z dobropisované po stornu opravy vede cesta zpět na základ", () => {
    expect(deriveStatus({ ...sent, status: "credited" })).toBe("sent");
    expect(deriveStatus({ ...sent, status: "credited", sentAt: null })).toBe("issued");
    expect(deriveStatus({ ...sent, status: "credited", paidMinor: 400 })).toBe("partially_paid");
  });

  test("doplatek po záloze má základní stav, ne částečnou úhradu", () => {
    expect(deriveStatus({ ...sent, advanceMinor: 400 })).toBe("sent");
    expect(deriveStatus({ ...sent, advanceMinor: 1000 })).toBe("paid");
  });

  test("stav nezávisí na předchozím: bez vlastní platby rozhoduje sent_at", () => {
    for (const status of ["sent", "paid", "partially_paid"] as const) {
      expect(deriveStatus({ ...sent, status, advanceMinor: 400 })).toBe("sent");
      expect(deriveStatus({ ...sent, status, advanceMinor: 400, sentAt: null })).toBe("issued");
      expect(deriveStatus({ ...sent, status, advanceMinor: 400, paidMinor: 100 })).toBe(
        "partially_paid",
      );
    }
  });

  test("po vrácení celé zálohy jde faktura na základní stav", () => {
    expect(deriveStatus({ ...sent, status: "paid" })).toBe("sent");
  });

  test("zůstatek uzavřený opravou a zálohou zůstává uhrazený, ne dobropisovaný", () => {
    expect(deriveStatus({ ...sent, creditsMinor: -400, advanceMinor: 600 })).toBe("paid");
  });
});

describe("isRefund", () => {
  test("vrácení je jen záporně připsaná částka", () => {
    expect(isRefund({ creditedMinor: -1 })).toBe(true);
    expect(isRefund({ creditedMinor: 0 })).toBe(false);
    expect(isRefund({ creditedMinor: 1 })).toBe(false);
  });
});

describe("canAmendPayment", () => {
  test("oproti přijetí platby přibývá dobropisovaná", () => {
    expect(INVOICE_STATUSES.filter(canAmendPayment)).toEqual([
      "issued",
      "sent",
      "partially_paid",
      "paid",
      "credited",
    ]);
  });
});

describe("canTakePayment", () => {
  test("platbu berou jen vystavené doklady", () => {
    expect(INVOICE_STATUSES.filter(canTakePayment)).toEqual([
      "issued",
      "sent",
      "partially_paid",
      "paid",
    ]);
  });
});

describe("výčty a vstup", () => {
  const input = {
    revision: 1,
    paidOn: "2026-03-10",
    amountMinor: 100,
    currency: "CZK",
    method: "transfer",
    note: "",
  };

  test("[PAY-003] způsob, zdroj a druh mají pevné hodnoty", () => {
    expect(PAYMENT_CHANNELS).toEqual(["transfer", "cash", "other"]);
    expect(PAYMENT_SOURCES).toEqual(["manual", "notice", "import"]);
    expect(PAYMENT_KINDS).toEqual(["payment", "difference"]);
    expect(paymentInputSchema.parse({ ...input, note: "  záloha " }).note).toBe("záloha");
  });

  test.each([
    ["nulová částka", { amountMinor: 0 }],
    ["záporná částka", { amountMinor: -1 }],
    ["desetinná částka", { amountMinor: 1.5 }],
    ["příliš vysoká částka", { amountMinor: MAX_DOCUMENT_MINOR + 1 }],
    ["nulová připsaná částka", { creditedMinor: 0 }],
    ["příliš vysoká připsaná částka", { creditedMinor: MAX_DOCUMENT_MINOR + 1 }],
    ["neplatné datum", { paidOn: "2026-02-30" }],
    ["neznámá měna", { currency: "XXX" }],
    ["způsob dokladu mimo výčet platby", { method: "card" }],
    ["dlouhá poznámka", { note: "x".repeat(501) }],
  ])("odmítne: %s", (_name, over) => {
    expect(paymentInputSchema.safeParse({ ...input, ...over }).success).toBe(false);
  });

  test("hraniční hodnoty projdou", () => {
    const edge = {
      ...input,
      amountMinor: MAX_DOCUMENT_MINOR,
      creditedMinor: 1,
      note: "x".repeat(500),
    };
    expect(paymentInputSchema.safeParse(edge).success).toBe(true);
    expect(paymentInputSchema.safeParse({ ...input, amountMinor: 1 }).success).toBe(true);
  });
});
